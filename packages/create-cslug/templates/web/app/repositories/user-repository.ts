import { inject } from '@cslug/core'
import { Repository } from '@cslug/database'
import { users } from '#app/tables/user-table'

@inject()
export class UserRepository extends Repository(users) {}
