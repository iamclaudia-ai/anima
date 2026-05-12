import { File, FileImage, FileText, X } from "lucide-react";
import type { Attachment } from "../types";

function getFileIcon(mediaType: string) {
  if (mediaType.startsWith("image/")) return FileImage;
  if (mediaType.startsWith("text/") || mediaType === "application/pdf") return FileText;
  return File;
}

interface AttachmentsListProps {
  attachments: Attachment[];
  onRemove(index: number): void;
}

/**
 * Render the attachment-chip strip above the textarea. Image attachments show
 * a thumbnail; everything else shows the filename next to a file icon.
 */
export function AttachmentsList({ attachments, onRemove }: AttachmentsListProps) {
  if (attachments.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {attachments.map((attachment, idx) => {
        const FileIcon = getFileIcon(attachment.mediaType);
        // Content-derived key — Attachment has no stable id and a single message
        // can carry multiple files with identical names/types, so hash a slice
        // of the base64 data for uniqueness within the list.
        const key = `${attachment.type}:${attachment.filename ?? ""}:${attachment.data.slice(0, 24)}`;
        return (
          <div key={key} className="relative group">
            {attachment.type === "image" ? (
              <img
                src={`data:${attachment.mediaType};base64,${attachment.data}`}
                alt={attachment.filename || `Attachment ${idx + 1}`}
                className="size-16 object-cover rounded-md border border-gray-300"
              />
            ) : (
              <div className="h-16 px-3 flex items-center gap-2 rounded-md border border-gray-300 bg-gray-50">
                <FileIcon className="size-5 text-gray-500" />
                <span className="text-xs text-gray-700 max-w-24 truncate">
                  {attachment.filename || "file"}
                </span>
              </div>
            )}
            <button
              onClick={() => onRemove(idx)}
              className="absolute -top-1 -right-1 size-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label={`Remove attachment ${attachment.filename || idx + 1}`}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
