import { SagaflowError } from './errors.js'
import type { StandardSchemaV1 } from './types.js'

const describePath = (issue: StandardSchemaV1.Issue): string => {
  if (!issue.path || issue.path.length === 0) return ''

  const path = issue.path
    .map((segment) =>
      typeof segment === 'object' && segment !== null && 'key' in segment
        ? String(segment.key)
        : String(segment),
    )
    .join('.')

  return `${path}: `
}

/**
 * What a refused value throws. It carries the issues as the schema reported them, because the
 * caller that has to fix the value needs the path and not just "invalid".
 */
export class SchemaError extends SagaflowError {
  readonly issues: ReadonlyArray<StandardSchemaV1.Issue>

  constructor(subject: string, issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    super(
      `${subject} is invalid: ${issues.map((issue) => `${describePath(issue)}${issue.message}`).join('; ')}`,
    )

    this.name = 'SchemaError'
    this.issues = issues
  }
}

/**
 * Validation over the Standard Schema interface, awaiting validators that are asynchronous.
 * Used wherever the engine has an async moment to spend: parsing a workflow's input.
 */
export const validate = async <Schema extends StandardSchemaV1>(
  schema: Schema,
  value: unknown,
  subject: string,
): Promise<StandardSchemaV1.InferOutput<Schema>> => {
  const result = await schema['~standard'].validate(value)
  if (result.issues) throw new SchemaError(subject, result.issues)

  return result.value
}

/**
 * The same, without an await to spend. `emit` returns void — a body calls it and carries on —
 * so an asynchronous validator cannot be awaited there and is refused with a message that
 * says so rather than silently letting an unchecked payload through.
 */
export const validateSync = <Schema extends StandardSchemaV1>(
  schema: Schema,
  value: unknown,
  subject: string,
): StandardSchemaV1.InferOutput<Schema> => {
  const result = schema['~standard'].validate(value)

  if (result instanceof Promise) {
    throw new SchemaError(subject, [
      { message: 'this schema validates asynchronously, and emit cannot await it' },
    ])
  }

  if (result.issues) throw new SchemaError(subject, result.issues)

  return result.value
}
