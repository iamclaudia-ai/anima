export interface JournalEntry {
  timestamp: Date
  filePath: string
  categories: string[]
}

export interface JournalThoughts {
  // Personal journey (global journal)
  heart_thoughts?: string
  michael_notes?: string
  dreams?: string
  reflections?: string
  growth?: string
  // Project-specific (project journal)
  project_notes?: string
}

export interface JournalPaths {
  global: string
  project: string
}
