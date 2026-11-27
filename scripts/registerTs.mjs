// Lets Node run the app's TypeScript directly: src/ imports omit the `.ts`
// extension (Vite resolves them), so a failed relative import retries with it.
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../')
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !relative || /\.[cm]?[jt]sx?$/.test(specifier)) throw error
      return next(`${specifier}.ts`, context)
    }
  },
})
