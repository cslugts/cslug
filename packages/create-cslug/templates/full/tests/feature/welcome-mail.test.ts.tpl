import { test } from 'bun:test'
import { testApp } from '@cslug/testing'
import { WelcomeMail } from '#app/mail/welcome-mail'

const app = testApp({ fakes: ['mail'] })

test('registering queues the welcome mail', async () => {
  await app
    .post('/register')
    .form({
      name: 'Ada',
      email: 'ada@example.test',
      password: 'correct horse battery',
      passwordConfirmation: 'correct horse battery',
    })
    .assertRedirect('/dashboard')
  app.mail.assertQueued(
    WelcomeMail,
    (m) => m.to === 'ada@example.test' && m.subject === 'Welcome aboard' && !!m.text?.includes('Your account is ready.'),
  )
})
