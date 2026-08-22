import { z } from 'zod'

// A small event vocabulary for the suites, declared the way a real caller declares one: a map
// of type to schema, handed to the runtime so emits are both typed and validated.
export const testEventSchemas = {
  'invoice.issued': z.object({ invoiceId: z.string().min(1), total: z.number() }),
  'invoice.voided': z.object({ invoiceId: z.string().min(1) }),
}

export type TestEventSchemas = typeof testEventSchemas
