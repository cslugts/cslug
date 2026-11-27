import { v } from '@cslug/validation'

export const TwoFactorValidator = v.object({ code: v.string().trim().min(1).max(32) })
