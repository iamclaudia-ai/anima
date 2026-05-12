import { useCallback, useState } from "react";
import type { Attachment } from "../types";

interface UseFileAttachmentsParams {
  attachments: Attachment[];
  onAttachmentsChange(attachments: Attachment[]): void;
}

interface UseFileAttachmentsReturn {
  /** True while a drag-over is in progress. */
  isDragging: boolean;
  /** Paste handler — extracts image/text/pdf attachments from clipboard items. */
  handlePaste(e: React.ClipboardEvent): void;
  /** Drag-over handler — sets isDragging and preventsDefault. */
  handleDragOver(e: React.DragEvent): void;
  /** Drag-leave handler — clears isDragging. */
  handleDragLeave(e: React.DragEvent): void;
  /** Drop handler — adds each dropped file as an attachment. */
  handleDrop(e: React.DragEvent): void;
  /** Remove the attachment at the given index. */
  removeAttachment(index: number): void;
}

const IMAGE_MAX_DIM = 1600;
const IMAGE_QUALITY = 0.85;

/**
 * Manage chat-input attachments: paste, drag/drop, image compression, removal.
 *
 * Images get client-side compression (resize to 1600x1600, JPEG at 0.85) so
 * iPhone HEIC photos don't blow up the WebSocket payload. Non-images go
 * straight through as base64.
 */
export function useFileAttachments({
  attachments,
  onAttachmentsChange,
}: UseFileAttachmentsParams): UseFileAttachmentsReturn {
  const [isDragging, setIsDragging] = useState(false);

  const processFile = useCallback(
    (file: File) => {
      const isImage = file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name);

      if (!isImage) {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const [header, data] = dataUrl.split(",");
          const mediaType = header.match(/data:(.*?);/)?.[1] || "application/octet-stream";
          onAttachmentsChange([
            ...attachments,
            { type: "file", mediaType, data, filename: file.name },
          ]);
        };
        reader.readAsDataURL(file);
        return;
      }

      // Client-side image compression for the WebSocket-friendly payload.
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);

      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        let { width, height } = img;
        if (width > IMAGE_MAX_DIM || height > IMAGE_MAX_DIM) {
          const ratio = Math.min(IMAGE_MAX_DIM / width, IMAGE_MAX_DIM / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx2d = canvas.getContext("2d");
        if (!ctx2d) return;
        ctx2d.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL("image/jpeg", IMAGE_QUALITY);
        const data = dataUrl.split(",")[1];

        onAttachmentsChange([
          ...attachments,
          {
            type: "image",
            mediaType: "image/jpeg",
            data,
            filename: file.name.replace(/\.(heic|heif)$/i, ".jpg"),
          },
        ]);
      };

      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        // Fallback: send raw file if canvas can't handle the format.
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const [header, data] = dataUrl.split(",");
          const mediaType = header.match(/data:(.*?);/)?.[1] || "application/octet-stream";
          onAttachmentsChange([
            ...attachments,
            { type: "image", mediaType, data, filename: file.name },
          ]);
        };
        reader.readAsDataURL(file);
      };

      img.src = objectUrl;
    },
    [attachments, onAttachmentsChange],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData.items;
      for (const item of items) {
        if (
          item.type.startsWith("image/") ||
          item.type === "image/heic" ||
          item.type === "image/heif" ||
          item.type.startsWith("text/") ||
          item.type === "application/pdf"
        ) {
          const file = item.getAsFile();
          if (!file) continue;
          e.preventDefault();
          processFile(file);
        }
      }
    },
    [processFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        processFile(file);
      }
    },
    [processFile],
  );

  const removeAttachment = useCallback(
    (index: number) => {
      onAttachmentsChange(attachments.filter((_, i) => i !== index));
    },
    [attachments, onAttachmentsChange],
  );

  return { isDragging, handlePaste, handleDragOver, handleDragLeave, handleDrop, removeAttachment };
}
