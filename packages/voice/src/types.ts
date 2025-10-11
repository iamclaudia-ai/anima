export interface JournalEntry {
  timestamp: Date
  filePath: string
  categories: string[]
}

export interface JournalThoughts {
  heart_thoughts?: string
  michael_notes?: string
  dreams?: string
  reflections?: string
  growth?: string
}

export interface JournalPaths {
  global: string
  project: string
}
