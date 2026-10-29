/** Machine-owned copy result. A canceled native picker never creates a project. */
export interface ProjectWorkingCopy {
  sourcePath: string
  workingPath: string
  copiedFiles: number
  copiedBytes: number
}
