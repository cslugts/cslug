import { inject } from '@cslug/core'
import { type HttpContext, redirect, route } from '@cslug/http'

@inject()
export class HomeController {
  /** `/` → the todo list for users, the login page for guests. */
  async index({ auth }: HttpContext) {
    return redirect().to(auth.check() ? route('todos.index') : route('login'))
  }
}
