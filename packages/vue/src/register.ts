/** `[test] preload = ["@cslug/vue/register"]` in bunfig.toml: import `.vue` files from the first line. */
import { registerVueLoader } from './loader'

registerVueLoader(process.cwd())
