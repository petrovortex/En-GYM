export type QualityStage = 'draft' | 'audit-format' | 'audit-content'

// A rejected exercise can be repaired; quota, transport and local-audio failures cannot.
export class QualityError extends Error {
  stage: QualityStage
  issues: string[]
  constructor(stage: QualityStage, issues: string[]) {
    const details = issues.slice(0, 12).map((issue) => issue.slice(0, 1200))
    super('Item rejected during independent review: ' + details.join(' '))
    this.stage = stage
    this.issues = details
  }
}
