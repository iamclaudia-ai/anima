#!/usr/bin/env bash

set -u

SESSION_NAME="${TMUX_WRAP_SESSION:-anima-session}"
MAX_PANES="${TMUX_WRAP_MAX_PANES:-8}"
BASE_DIR="${TMPDIR:-/tmp}"
SCRIPT_PATH="${BASH_SOURCE[0]}"
if [[ "$SCRIPT_PATH" != /* ]]; then
  SCRIPT_PATH="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)/$(basename -- "$SCRIPT_PATH")"
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
SHELL_POLICY_HELPER="${TMUX_WRAP_SHELL_POLICY_HELPER:-${SCRIPT_DIR}/../packages/shell-parser/src/cli.ts}"
SESSION_KEY="$(printf "%s" "$SESSION_NAME" | tr -c '[:alnum:]_.-' '_')"
LOCK_DIR="${BASE_DIR%/}/tmux-wrap.${SESSION_KEY}.lock"
IDLE_TOKEN="tmux-wrap-idle-${SESSION_KEY}"

usage() {
  cat <<'EOF'
Usage:
  tmux-wrap.sh [--no-tokf] --shell <command-string>
  tmux-wrap.sh [--no-tokf] <command> [args...]
  tmux-wrap.sh --hook
  tmux-wrap.sh --hook-codex
  tmux-wrap.sh --hook-filter-only

Environment:
  TMUX_WRAP_SESSION   tmux session/group to use (default: anima-session)
  TMUX_WRAP_MAX_PANES max panes in the target tmux window (default: 8)
  TMUX_WRAP_NO_TOKF   run the command raw instead of through tokf rewrite

Attach:
  tmux attach -t anima-session
EOF
}

q() {
  printf "%q" "$1"
}

die() {
  printf "tmux-wrap: %s\n" "$*" >&2
  exit 1
}

policy_json_for_command() {
  local command="$1"

  [ "${TMUX_WRAP_NO_AST_POLICY:-}" = "1" ] && return 1
  command -v bun >/dev/null 2>&1 || return 1
  [ -f "$SHELL_POLICY_HELPER" ] || return 1

  printf "%s" "$command" | bun run "$SHELL_POLICY_HELPER" policy 2>/dev/null
}

deny_reason_for_command() {
  local command="$1"
  local command_positions="${command//$'\n'/;}"
  local policy_json

  if policy_json="$(policy_json_for_command "$command")"; then
    if jq -e '.ok == true and (.denyReason | type == "string")' >/dev/null 2>&1 <<<"$policy_json"; then
      jq -r '.denyReason' <<<"$policy_json"
      return 0
    fi
    jq -e '.ok == true and .denyReason == null' >/dev/null 2>&1 <<<"$policy_json" && return 1
  fi

  if [[ "$command" =~ (^|[[:space:]\;\&\|\(\)])rg([[:space:]]+[^[:space:]\;\&\|\(\)]+)*[[:space:]]+-[[:alpha:]]*r[[:alpha:]]*[nl][[:alpha:]]*([[:space:]\;\&\|\)]|$) ]] ||
     [[ "$command" =~ (^|[[:space:]\;\&\|\(\)])rg([[:space:]]+[^[:space:]\;\&\|\(\)]+)*[[:space:]]+-[[:alpha:]]*[nl][[:alpha:]]*r[[:alpha:]]*([[:space:]\;\&\|\)]|$) ]]; then
    printf "%s" "Blocked: don't use grep-style compact ripgrep flags like 'rg -rn' or 'rg -rl'. In ripgrep, -r means --replace, so '-rn' replaces matches with 'n' and '-rl' replaces matches with 'l', corrupting source-looking output. Use 'rg -n' for line numbers or 'rg -l' for filenames; ripgrep searches recursively by default."
    return 0
  fi

  if [[ "$command_positions" =~ (^|[;\|\&\(\`]|\$\()[[:space:]]*gh-stack([[:space:]]|$) ]] &&
     [[ "$command" =~ \|[[:space:]]*(tail|head)([[:space:]]|$) ]]; then
    printf "%s" "Blocked: don't pipe gh-stack into tail/head. It can hang the wrapper or get killed mid-operation (exit 143), leaving a rebase/push half-done. Re-run plainly; use 'tokf raw last' for the full output."
    return 0
  fi

  case "$command" in
    *"tmux kill-server"*|*"tmux "*'kill-server'*|*"tmux"*" kill-server"*)
      printf "%s" "Blocked: tmux kill-server would terminate the tmux-wrap session and may kill the agent CLI itself. Tell Michael tmux is broken and ask him to restart or repair the tmux wrapper/session instead."
      return 0
      ;;
  esac

  return 1
}

should_passthrough_command() {
  local command="$1"

  case "$command" in
    *"tmux-wrap.sh"*) return 0 ;;
    "tmux attach"|\
    "tmux attach "*|\
    "tmux attach-session"|\
    "tmux attach-session "*|\
    "tmux a"|\
    "tmux a "*) return 0 ;;
  esac

  return 1
}

should_skip_tokf_command() {
  local command="$1"
  local policy_json

  # tokf rewrite can corrupt shell offsets when a command contains embedded
  # newlines, especially multi-line quoted strings such as commit messages.
  # Run these raw; tmux remains the full-fidelity transcript.
  [[ "$command" == *$'\n'* ]] && return 0

  if policy_json="$(policy_json_for_command "$command")"; then
    jq -e '.ok == true and .skipTokf == true' >/dev/null 2>&1 <<<"$policy_json" && return 0
    jq -e '.ok == true and .skipTokf == false' >/dev/null 2>&1 <<<"$policy_json" && return 1
  fi

  # tokf's built-in gh filters own their own --json projection and output
  # template. If the caller supplied an explicit gh JSON/jq projection, running
  # it through tokf can preserve the shell command but apply the wrong template
  # to the projected JSON, producing blank fields. Let these commands run raw.
  case "$command" in
    gh\ *--json*|\
    gh\ *--jq*|\
    gh\ *" -q "*|\
    *" gh "*--json*|\
    *" gh "*--jq*|\
    *" gh "*" -q "*) return 0 ;;
  esac

  # Search output is often source code. Any token-level compression here is
  # dangerous because it can turn exact matches into plausible-but-wrong code
  # (for example identifiers or "*" rendered as "n"). If a shell line contains
  # a source search command anywhere in a pipeline/compound command, run the
  # whole line raw.
  if [[ "$command" =~ (^|[[:space:]\;\&\|\(\)])(rg|grep|egrep|fgrep)([[:space:]]|$) ]] ||
     [[ "$command" =~ (^|[[:space:]\;\&\|\(\)])git[[:space:]]+grep([[:space:]]|$) ]]; then
    return 0
  fi

  return 1
}

# Normalize a runtime session id to its leading UUID. Claude CLI/SDK and Codex
# all key sessions on a UUID, but some runtimes append a suffix (e.g.
# "<uuid>-10") that makes the derived tmux session name unpredictable and forces
# a `tmux ls` before attaching. Strip to the leading UUID when present so the
# name matches the id the human already knows; pass non-UUID ids through.
normalize_session_id() {
  local id="$1"
  if [[ "$id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12} ]]; then
    printf '%s' "${BASH_REMATCH[0]}"
  else
    printf '%s' "$id"
  fi
}

# Strip ANSI escape sequences (color, cursor moves, progress redraws) from a
# stream. Commands run in a tmux PTY, so tools think they're interactive and
# emit color; tokf can even force child color (to filter it) which defeats
# NO_COLOR. Stripping unconditionally guarantees the caller — and the human
# watching the identical pane stream — get clean text. Pass-through if no perl.
strip_ansi() {
  if command -v perl >/dev/null 2>&1; then
    perl -pe 'BEGIN { $| = 1 } s/\x1b\[[0-9;?]*[ -\/]*[@-~]//g'
  else
    cat
  fi
}

# Replace the absolute working-directory prefix in every output line without
# adding a relative marker. Commands like `find`, `grep -r`, `rg`, and compiler
# diagnostics emit absolute paths even when the workspace cwd is already known.
# Keep the useful path, drop only the redundant cwd prefix:
#   1. "<cwd>/foo" -> "foo"
#   2. "<cwd>" at a boundary (eol / whitespace / ":") -> "."
strip_cwd() {
  if [ -n "${PWD:-}" ] && command -v perl >/dev/null 2>&1; then
    TMUX_WRAP_CWD="$PWD" perl -pe 'BEGIN { $| = 1; $c = $ENV{TMUX_WRAP_CWD} }
      s{\Q$c\E/}{}g;
      s{\Q$c\E(?=$|[\s:])}{.}g'
  else
    cat
  fi
}

command_from_argv() {
  local out="" arg

  if [ "$#" -eq 1 ]; then
    printf "%s" "$1"
    return
  fi

  for arg in "$@"; do
    out+="$(q "$arg") "
  done
  printf "%s" "${out% }"
}

emit_hook_output() {
  command -v jq >/dev/null 2>&1 || die "jq is required for --hook"

  local input command wrapped quoted_script quoted_command quoted_session decision
  local session_id safe_sid session_name
  input="$(cat)"
  command="$(jq -r 'select(.tool_name == "Bash") | .tool_input.command // empty' <<<"$input")"
  decision="${TMUX_WRAP_HOOK_DECISION:-ask}"

  if [ -z "$command" ]; then
    exit 0
  fi

  local deny_reason
  if deny_reason="$(deny_reason_for_command "$command")"; then
    jq -n --arg reason "$deny_reason" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason
      }
    }'
    return
  fi

  should_passthrough_command "$command" && exit 0

  case "$decision" in
    allow|ask) ;;
    *) decision="ask" ;;
  esac

  # Give each Claude Code session its own tmux session so concurrent agents
  # never share panes. session_id comes from the PreToolUse hook payload; if it
  # is missing we fall back to the base SESSION_NAME. Normalize to the leading
  # UUID so a suffixed id (e.g. "<uuid>-10" from the agent SDK) still maps to the
  # clean, attachable name. tmux session names cannot contain '.' or ':', so
  # sanitize to a safe charset.
  session_id="$(jq -r '.session_id // empty' <<<"$input")"
  session_id="$(normalize_session_id "$session_id")"
  session_name="$SESSION_NAME"
  if [ -n "$session_id" ]; then
    safe_sid="$(printf '%s' "$session_id" | tr -c '[:alnum:]_-' '_')"
    session_name="${SESSION_NAME}-${safe_sid}"
  fi

  quoted_script="$(q "$SCRIPT_PATH")"
  quoted_command="$(q "$command")"
  quoted_session="$(q "$session_name")"
  wrapped="TMUX_WRAP_SESSION=${quoted_session} ${quoted_script} --shell ${quoted_command}"

  jq -n \
    --argjson original "$(jq '.tool_input' <<<"$input")" \
    --arg command "$wrapped" \
    --arg decision "$decision" \
    '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: $decision,
        permissionDecisionReason: "Run Bash tool calls through tmux-wrap",
        updatedInput: ($original + {command: $command})
      }
    }'
}

rewrite_with_tokf() {
  local command="$1"
  local rewritten

  if [[ "$command" != *$'\n'* ]] && ! should_skip_tokf_command "$command" && command -v tokf >/dev/null 2>&1; then
    rewritten="$(tokf rewrite "$command" 2>/dev/null)"
    if [ -z "$rewritten" ]; then
      rewritten="$command"
    elif [[ "$rewritten" == "tokf run "* ]]; then
      rewritten="tokf run --no-mask-exit-code ${rewritten#tokf run }"
    fi
  else
    rewritten="$command"
  fi

  printf "%s" "$rewritten"
}

emit_filter_only_hook_output() {
  command -v jq >/dev/null 2>&1 || die "jq is required for --hook-filter-only"

  local input command rewritten decision
  input="$(cat)"
  command="$(jq -r 'select(.tool_name == "Bash") | .tool_input.command // empty' <<<"$input")"
  decision="${TMUX_WRAP_HOOK_DECISION:-allow}"

  if [ -z "$command" ]; then
    exit 0
  fi

  local deny_reason
  if deny_reason="$(deny_reason_for_command "$command")"; then
    jq -n --arg reason "$deny_reason" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason
      }
    }'
    return
  fi

  should_passthrough_command "$command" && exit 0

  case "$decision" in
    allow|ask) ;;
    *) decision="allow" ;;
  esac

  rewritten="$(rewrite_with_tokf "$command")"
  if [ "$rewritten" = "$command" ]; then
    exit 0
  fi

  jq -n \
    --argjson original "$(jq '.tool_input' <<<"$input")" \
    --arg command "$rewritten" \
    --arg decision "$decision" \
    '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: $decision,
        permissionDecisionReason: "Run Bash tool call through tokf filter only",
        updatedInput: ($original + {command: $command})
      }
    }'
}

emit_codex_hook_output() {
  command -v jq >/dev/null 2>&1 || die "jq is required for --hook-codex"

  local input command command_key wrapped quoted_script quoted_command quoted_session decision
  local session_id safe_sid session_name
  input="$(cat)"
  command="$(jq -r '(.tool_input.command // .tool_input.cmd // empty) | strings' <<<"$input")"
  command_key="$(jq -r 'if (.tool_input.command | type) == "string" then "command" elif (.tool_input.cmd | type) == "string" then "cmd" else empty end' <<<"$input")"
  decision="${TMUX_WRAP_HOOK_DECISION:-allow}"

  if [ -z "$command" ] || [ -z "$command_key" ]; then
    exit 0
  fi

  local deny_reason
  if deny_reason="$(deny_reason_for_command "$command")"; then
    jq -n --arg reason "$deny_reason" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason
      }
    }'
    return
  fi

  should_passthrough_command "$command" && exit 0

  # Codex PreToolUse supports allow+updatedInput and deny, but not ask.
  case "$decision" in
    allow|deny) ;;
    *) decision="allow" ;;
  esac

  session_id="$(jq -r '.session_id // empty' <<<"$input")"
  session_id="$(normalize_session_id "$session_id")"
  session_name="$SESSION_NAME"
  if [ -n "$session_id" ]; then
    safe_sid="$(printf '%s' "$session_id" | tr -c '[:alnum:]_-' '_')"
    session_name="${SESSION_NAME}-${safe_sid}"
  fi

  quoted_script="$(q "$SCRIPT_PATH")"
  quoted_command="$(q "$command")"
  quoted_session="$(q "$session_name")"
  wrapped="TMUX_WRAP_SESSION=${quoted_session} ${quoted_script} --shell ${quoted_command}"

  if [ "$decision" = "deny" ]; then
    jq -n '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Blocked by tmux-wrap hook"
      }
    }'
    return
  fi

  jq -n \
    --argjson original "$(jq '.tool_input' <<<"$input")" \
    --arg key "$command_key" \
    --arg command "$wrapped" \
    '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Run Bash tool calls through tmux-wrap",
        updatedInput: ($original + {($key): $command})
      }
    }'
}

ensure_session() {
  # Anchor the session (and thus its panes) to the caller's workspace cwd so
  # commands — and tokf's per-project history attribution — land in the right
  # project. $PWD here is run_parent's cwd, i.e. the caller's workspace.
  if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    if ! tmux new-session -d -s "$SESSION_NAME" -c "$PWD" -n agent >/dev/null 2>&1; then
      tmux has-session -t "$SESSION_NAME" 2>/dev/null || die "could not create tmux session: $SESSION_NAME"
    fi
  fi
}

acquire_lock() {
  local _ holder

  for _ in {1..200}; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      printf "%s" "$$" >"$LOCK_DIR/pid"
      return
    fi

    # The lock is held. Reclaim it if the holder is gone — otherwise a command
    # killed mid-allocation would wedge every future command (10s stall then a
    # hard failure needing a manual rm). Prefer the recorded PID; fall back to
    # age for the tiny window where a holder died before writing its PID.
    holder="$(cat "$LOCK_DIR/pid" 2>/dev/null)"
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$LOCK_DIR" 2>/dev/null || true
      continue
    fi
    if [ -z "$holder" ] && [ -n "$(find "$LOCK_DIR" -prune -mmin +1 2>/dev/null)" ]; then
      rm -rf "$LOCK_DIR" 2>/dev/null || true
      continue
    fi

    sleep 0.05
  done

  die "could not acquire pane allocation lock: $LOCK_DIR"
}

release_lock() {
  # rm -rf, not rmdir: the lock dir holds a pid file now.
  rm -rf "$LOCK_DIR" 2>/dev/null || true
}

find_idle_pane() {
  tmux list-panes -t "$SESSION_NAME:" -F '#{pane_id}	#{pane_current_command}	#{@tmux-wrap-state}' |
    awk -F '\t' '$2 ~ /^(bash|zsh|sh)$/ && $3 != "busy" { print $1; exit }'
}

pane_count() {
  tmux list-panes -t "$SESSION_NAME:" -F '#{pane_id}' | wc -l | tr -d ' '
}

allocate_pane() {
  local child_cmd="$1"
  local run_id="$2"
  local pane_id count

  while true; do
    acquire_lock

    pane_id="$(find_idle_pane)"
    if [ -n "$pane_id" ]; then
      tmux set-option -p -t "$pane_id" @tmux-wrap-owned 1 >/dev/null 2>&1 || true
      tmux set-option -p -t "$pane_id" @tmux-wrap-state busy >/dev/null 2>&1 || true
      tmux select-pane -t "$pane_id" -T "tmux-wrap-busy-$run_id" >/dev/null 2>&1 || true
      # A human scrolling puts the pane in copy-mode, where send-keys is
      # captured by the mode instead of reaching the shell — the command would
      # silently never run and the parent would hang. Exit copy-mode first.
      if [ "$(tmux display-message -p -t "$pane_id" '#{pane_in_mode}' 2>/dev/null)" = "1" ]; then
        tmux send-keys -t "$pane_id" -X cancel >/dev/null 2>&1 || true
      fi
      tmux send-keys -t "$pane_id" C-u
      tmux send-keys -t "$pane_id" -l "$child_cmd"
      tmux send-keys -t "$pane_id" Enter
      release_lock
      printf "%s" "$pane_id"
      return
    fi

    count="$(pane_count)"
    if [ "$count" -lt "$MAX_PANES" ]; then
      pane_id="$(tmux split-window -d -P -F '#{pane_id}' -c "$PWD" -t "$SESSION_NAME:" "$child_cmd" 2>/dev/null)"
      if [ -z "$pane_id" ]; then
        pane_id="$(tmux new-window -d -P -F '#{pane_id}' -c "$PWD" -t "$SESSION_NAME:" "$child_cmd" 2>/dev/null)" || {
          release_lock
          die "could not create tmux pane/window"
        }
      fi

      tmux select-pane -t "$pane_id" -T "tmux-wrap-busy-$run_id" >/dev/null 2>&1 || true
      tmux set-option -p -t "$pane_id" @tmux-wrap-owned 1 >/dev/null 2>&1 || true
      tmux set-option -p -t "$pane_id" @tmux-wrap-state busy >/dev/null 2>&1 || true
      tmux select-layout -t "$SESSION_NAME:" tiled >/dev/null 2>&1 || true
      release_lock
      printf "%s" "$pane_id"
      return
    fi

    release_lock
    tmux wait-for "$IDLE_TOKEN"
  done
}

write_parent_env() {
  local env_file="$1"
  local name

  : >"$env_file"
  for name in $(compgen -e); do
    printf 'export %s=%q\n' "$name" "${!name}" >>"$env_file"
  done
}

run_child() {
  local run_dir="$1"
  local done_token="$2"
  local command output status_file env_file cwd_file use_tokf rewritten status parent_pid

  command="$(cat "$run_dir/command")"
  output="$run_dir/output"
  status_file="$run_dir/status"
  env_file="$run_dir/env.sh"
  cwd_file="$run_dir/cwd"
  use_tokf="$(cat "$run_dir/use_tokf")"

  # Match the caller's environment and working directory instead of tmux's
  # possibly stale server environment. env.sh is a snapshot of the caller's
  # full exported environment (PATH, tools, etc.) — i.e. the LOGIN-SHELL
  # environment Claude Code inherited when it was launched from the terminal.
  # We deliberately run the command below with `bash -c` (NON-login), NOT
  # `bash -lc`: the caller's login shell may be zsh, so `bash -l` would source
  # the wrong shell's profile (~/.bash_profile) on top. Sourcing env.sh here is
  # what actually carries the login-shell environment through, while bash keeps
  # bash-syntax commands working.
  # shellcheck disable=SC1090
  [ -f "$env_file" ] && source "$env_file"
  if [ -f "$cwd_file" ]; then
    cd "$(cat "$cwd_file")" || exit 127
  fi

  # Wrapper chrome (command echo + exit footer) goes ONLY to the pane PTY, for
  # a human watching via `tmux attach`. The `output` file — which the parent
  # tails back to the caller — carries ONLY the real, tokf-filtered command
  # output, so the caller sees a clean result with zero tmux-wrap noise.
  printf "[tmux-wrap] %s\n" "$command"

  # Decide whether to route the command through `tokf rewrite` for filtering, or
  # run it verbatim. tokf owns the shell-aware rewrite logic, including
  # top-level compound commands (`&&`, `||`, `;`, newlines) and simple pipe
  # handling. The wrapper's job is only to validate the rewritten shell and
  # execute it in a way that preserves the caller's expected exit-code
  # semantics.
  #
  # Important: plain `tokf rewrite` emits `tokf run ...`, and `tokf run` masks a
  # failing child exit to 0 by default. In a compound command that would break
  # shell short-circuiting (`cmd1 && cmd2`, `cmd1 || cmd2`). Rather than parsing
  # the rewritten shell here, define a temporary `tokf()` shell function for the
  # executed command that turns every `tokf run` invocation into
  # `tokf run --no-mask-exit-code`.
  #
  # As a final net, syntax-check tokf's output with `bash -n` and discard it if
  # it isn't valid shell. Every fallback runs the ORIGINAL command verbatim —
  # always correct, just unfiltered.
  rewritten="$command"
  local tokf_rewritten=0
  if [ "$use_tokf" = "1" ] && ! should_skip_tokf_command "$command" && command -v tokf >/dev/null 2>&1; then
    local candidate
    candidate="$(tokf rewrite "$command" 2>/dev/null)"
    if [ -n "$candidate" ] && bash -n -c "$candidate" 2>/dev/null; then
      rewritten="$candidate"
      if [ "$rewritten" != "$command" ]; then
        tokf_rewritten=1
      fi
    fi
  fi

  # Commands run in a tmux pane (a TTY), so tools' "am I being piped?" color
  # auto-detection sees a terminal and emits ANSI color — pure noise for the
  # caller. Force it off with NO_COLOR (the de-facto standard; it wins over
  # FORCE_COLOR in well-behaved tools). Set inline so only the executed command
  # is affected, not the idle login shell a human attaches to later.
  # Keep the pane's TTY on stdin ON PURPOSE: a human attached to the session
  # can answer interactive prompts (a key reason for the wrapper). Prompts are
  # visible because stderr is merged in (2>&1). A tool that reads stdin will
  # block until answered or the caller times out; when a command is known to be
  # non-interactive, the caller should pass `</dev/null` in the command itself.
  if [ "$tokf_rewritten" = "1" ]; then
    rewritten='tokf() {
  if [ "${1-}" = run ]; then
    shift
    if [ "${1-}" = --no-mask-exit-code ]; then
      command tokf run "$@"
    else
      command tokf run --no-mask-exit-code "$@"
    fi
  else
    command tokf "$@"
  fi
}
'"${rewritten}"
  fi

  NO_COLOR=1 bash -c "$rewritten" 2>&1 | strip_ansi | strip_cwd | tee -a "$output"

  status="${PIPESTATUS[0]}"
  printf "%s\n" "$status" >"$status_file"
  printf "\n[tmux-wrap] exit %s\n" "$status"

  tmux wait-for -S "$done_token"

  # If the parent wrapper process was killed by a tool timeout, it deliberately
  # leaves the child command running in this pane. In that detached case, the
  # child owns final recovery: mark the pane reusable and remove the run dir
  # after writing status/output. When the parent is still alive, it handles
  # status collection and cleanup.
  parent_pid="$(cat "$run_dir/parent_pid" 2>/dev/null || true)"
  if [ -n "${TMUX_PANE:-}" ]; then
    tmux set-option -p -t "$TMUX_PANE" @tmux-wrap-owned 1 >/dev/null 2>&1 || true
    tmux set-option -p -t "$TMUX_PANE" @tmux-wrap-state idle >/dev/null 2>&1 || true
    tmux select-pane -t "$TMUX_PANE" -T "tmux-wrap-idle" >/dev/null 2>&1 || true
    tmux wait-for -S "$IDLE_TOKEN" >/dev/null 2>&1 || true
  fi
  if [ -n "$parent_pid" ] && ! kill -0 "$parent_pid" 2>/dev/null; then
    rm -rf "$run_dir" 2>/dev/null || true
  fi

  exec "${SHELL:-/bin/bash}" -l
}

cleanup_parent() {
  # Stop tailing.
  [ -n "${tail_pid:-}" ] && kill "$tail_pid" 2>/dev/null

  # If we are dying before the child reported done (interrupt / Bash-tool
  # timeout), leave the command running in its pane. Killing here can corrupt
  # long-running mutating commands mid-push/rebase/migration. The child marks
  # the pane idle and removes the run dir after it finishes.
  if [ "${completed:-0}" != "1" ] && [ -n "${pane_id:-}" ]; then
    printf "tmux-wrap: parent exited before command completed; command left running in pane %s\n" "$pane_id" >&2
    printf "tmux-wrap: attach with: tmux attach -t %s\n" "$SESSION_NAME" >&2
  fi

  # The run dir holds the serialized parent environment (env.sh can contain
  # secrets). Remove it after normal completion; if the parent died early, the
  # child still needs the dir for output/status and removes it when done.
  if [ "${completed:-0}" = "1" ]; then
    [ -n "${run_dir:-}" ] && rm -rf "$run_dir" 2>/dev/null
  fi

  return 0
}

run_parent() {
  local command use_tokf run_id run_dir done_token child_cmd pane_id tail_pid status completed

  completed=0
  use_tokf=1
  if [ "${TMUX_WRAP_NO_TOKF:-}" = "1" ]; then
    use_tokf=0
  fi

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --no-tokf|--raw)
        use_tokf=0
        shift
        ;;
      --shell)
        shift
        [ "$#" -gt 0 ] || die "--shell requires a command string"
        command="$1"
        shift
        break
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      --)
        shift
        command="$(command_from_argv "$@")"
        set --
        break
        ;;
      *)
        command="$(command_from_argv "$@")"
        set --
        break
        ;;
    esac
  done

  [ "${command:-}" ] || die "no command provided"
  local deny_reason
  if deny_reason="$(deny_reason_for_command "$command")"; then
    printf "%s\n" "$deny_reason" >&2
    exit 126
  fi
  command -v tmux >/dev/null 2>&1 || die "tmux is not installed"

  ensure_session

  run_id="agent-$$-${RANDOM}"
  run_dir="${BASE_DIR%/}/tmux-wrap.${run_id}"
  done_token="tmux-wrap-done-${run_id}"
  mkdir -m 700 "$run_dir" || die "could not create run dir: $run_dir"

  # From here on, always clean up the run dir (secrets) and stop a runaway
  # child if we are interrupted before it finishes.
  trap 'exit 130' INT TERM
  trap cleanup_parent EXIT

  printf "%s" "$command" >"$run_dir/command"
  printf "%s" "$PWD" >"$run_dir/cwd"
  printf "%s" "$$" >"$run_dir/parent_pid"
  printf "%s" "$use_tokf" >"$run_dir/use_tokf"
  : >"$run_dir/output"
  write_parent_env "$run_dir/env.sh"

  child_cmd="$(q "$SCRIPT_PATH") --child $(q "$run_dir") $(q "$done_token")"

  pane_id="$(allocate_pane "$child_cmd" "$run_id")"

  # The caller (e.g. Claude Code) captures both stdout AND stderr, so anything
  # we print here becomes noise in their transcript. Keep it silent unless
  # TMUX_WRAP_DEBUG=1 is set for a human who wants the pane/attach hint.
  if [ "${TMUX_WRAP_DEBUG:-}" = "1" ]; then
    printf "[tmux-wrap] pane %s in session %s\n" "$pane_id" "$SESSION_NAME" >&2
    printf "[tmux-wrap] attach: tmux attach -t %s\n" "$SESSION_NAME" >&2
  fi

  tail -n +1 -f "$run_dir/output" &
  tail_pid="$!"

  tmux wait-for "$done_token"
  sleep 0.05
  kill "$tail_pid" 2>/dev/null || true
  wait "$tail_pid" 2>/dev/null || true
  tmux set-option -p -t "$pane_id" @tmux-wrap-owned 1 >/dev/null 2>&1 || true
  tmux set-option -p -t "$pane_id" @tmux-wrap-state idle >/dev/null 2>&1 || true
  tmux select-pane -t "$pane_id" -T "tmux-wrap-idle" >/dev/null 2>&1 || true
  tmux wait-for -S "$IDLE_TOKEN"

  status="$(cat "$run_dir/status" 2>/dev/null || printf "1")"
  completed=1
  exit "$status"
}

case "${1:-}" in
  --hook)
    emit_hook_output
    ;;
  --hook-codex)
    emit_codex_hook_output
    ;;
  --hook-filter-only)
    emit_filter_only_hook_output
    ;;
  --child)
    shift
    [ "$#" -eq 2 ] || die "--child requires run_dir and done token"
    run_child "$1" "$2"
    ;;
  *)
    run_parent "$@"
    ;;
esac
