import { describe, expect, it } from "bun:test";
import { RepoSyncService } from "./repo-sync";

describe("RepoSyncService", () => {
  it("coalesces queued requests into sequential sync runs", async () => {
    const starts: number[] = [];
    let inFlight = 0;
    let firstSyncBlocked = false;
    let resolveFirst: () => void = () => {
      throw new Error("first sync did not block as expected");
    };

    const service = new RepoSyncService(
      async () => {
        starts.push(Date.now());
        inFlight++;
        expect(inFlight).toBe(1);
        if (starts.length === 1) {
          firstSyncBlocked = true;
          await new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        inFlight--;
      },
      () => {},
    );

    service.start();
    service.requestSync("first");
    service.requestSync("second");

    await Bun.sleep(10);
    expect(starts.length).toBe(1);
    expect(firstSyncBlocked).toBe(true);

    service.requestSync("third");
    resolveFirst();

    await Bun.sleep(10);
    expect(starts.length).toBe(2);

    await service.stop();
    const diagnostics = service.getDiagnostics();
    expect(diagnostics.pending).toBe(false);
    expect(diagnostics.syncing).toBe(false);
    expect(diagnostics.lastError).toBeNull();
  });
});
