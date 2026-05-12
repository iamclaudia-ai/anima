import { useState, useEffect } from "react";
import { X, Folder, ChevronUp } from "lucide-react";
import {
  buildWorkspacePath,
  getWorkspaceParentPath,
  joinWorkspacePath,
} from "./createWorkspacePath";

interface CreateWorkspaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (cwd: string, name?: string, general?: boolean) => void;
  onGetDirectories: (path: string) => Promise<{ path: string; directories: string[] }>;
  isCreating: boolean;
}

export function CreateWorkspaceModal({
  isOpen,
  onClose,
  onSubmit,
  onGetDirectories,
  isCreating,
}: CreateWorkspaceModalProps) {
  const [currentPath, setCurrentPath] = useState("~/Projects");
  const [directories, setDirectories] = useState<string[]>([]);
  const [newFolderName, setNewFolderName] = useState("");
  const [name, setName] = useState("");
  const [general, setGeneral] = useState(false);
  const [isLoadingDirs, setIsLoadingDirs] = useState(false);

  // Load directories when path changes
  useEffect(() => {
    if (!isOpen) return;
    setIsLoadingDirs(true);
    onGetDirectories(currentPath)
      .then((result) => {
        setDirectories(result.directories);
        setCurrentPath(result.path); // Use resolved path from server
      })
      .catch(() => {
        setDirectories([]);
      })
      .finally(() => {
        setIsLoadingDirs(false);
      });
  }, [currentPath, isOpen, onGetDirectories]);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setCurrentPath("~/Projects");
      setNewFolderName("");
      setName("");
      setGeneral(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = () => {
    const finalPath = buildWorkspacePath(currentPath, newFolderName);
    onSubmit(finalPath, name.trim() || undefined, general);
  };

  const handleNavigateToDir = (dirName: string) => {
    setCurrentPath(joinWorkspacePath(currentPath, dirName));
  };

  const handleNavigateUp = () => {
    setCurrentPath(getWorkspaceParentPath(currentPath));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-gradient-to-b from-black/10 to-black/20 backdrop-blur-xs flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Create New Workspace</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Form */}
        <div className="p-6 space-y-4">
          {/* Current Path Display */}
          <div>
            <div className="block text-sm font-medium text-gray-700 mb-2">Browse Directories</div>
            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={handleNavigateUp}
                disabled={currentPath === "~" || isLoadingDirs}
                className="p-2 rounded-md border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Go up"
              >
                <ChevronUp className="size-4" />
              </button>
              <div className="flex-1 px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 text-sm font-mono text-gray-600">
                {currentPath}
              </div>
            </div>

            {/* Directory List */}
            <div className="border border-gray-200 rounded-lg max-h-48 overflow-y-auto">
              {isLoadingDirs ? (
                <div className="p-4 text-center text-sm text-gray-500">Loading...</div>
              ) : directories.length > 0 ? (
                <div className="divide-y divide-gray-200">
                  {directories.map((dir) => (
                    <button
                      key={dir}
                      onClick={() => handleNavigateToDir(dir)}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-left"
                    >
                      <Folder className="size-4 text-blue-500 flex-shrink-0" />
                      <span className="text-sm text-gray-700">{dir}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="p-4 text-center text-sm text-gray-500">No directories found</div>
              )}
            </div>
          </div>

          {/* New Folder Name */}
          <label className="block">
            <span className="block text-sm font-medium text-gray-700 mb-1">
              New Folder Name <span className="text-gray-400 font-normal">(optional)</span>
            </span>
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="my-new-project"
              className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none placeholder:text-gray-300"
              disabled={isCreating}
            />
            <p className="mt-1 text-xs text-gray-500">Create a new folder in the current path</p>
          </label>

          <label className="block">
            <span className="block text-sm font-medium text-gray-700 mb-1">
              Workspace Name <span className="text-gray-400 font-normal">(optional)</span>
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="my-project"
              className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none placeholder:text-gray-300"
              disabled={isCreating}
            />
            <p className="mt-1 text-xs text-gray-500">Defaults to folder name if not provided</p>
          </label>

          <label className="flex items-start gap-3 rounded-lg border border-gray-200 p-3 cursor-pointer hover:bg-gray-50">
            <input
              type="checkbox"
              checked={general}
              onChange={(e) => setGeneral(e.target.checked)}
              onKeyDown={handleKeyDown}
              disabled={isCreating}
              aria-label="General workspace"
              className="mt-0.5 size-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <div>
              <span className="block text-sm font-medium text-gray-800">General workspace</span>
              <p className="mt-1 text-xs text-gray-500">
                Archived summaries will be injected across all workspaces. Recent unsummarized
                messages still stay scoped to this folder.
              </p>
            </div>
          </label>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-200">
          <button
            onClick={onClose}
            disabled={isCreating}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isCreating}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title={
              newFolderName.trim()
                ? `Will create: ${buildWorkspacePath(currentPath, newFolderName)}`
                : `Use: ${currentPath}`
            }
          >
            {isCreating ? "Creating..." : "Create & Start Session"}
          </button>
        </div>
      </div>
    </div>
  );
}
