/** Stands in for bin.ts in supervisor tests: `serve` waits for SIGTERM; `crash` exits 1 at once. */
const [role] = process.argv.slice(2)
if (role === 'crash') process.exit(1)
console.log(`child ${role} up`)
process.on('SIGTERM', () => {
  console.log(`child ${role} draining`)
  setTimeout(() => process.exit(0), 100)
})
setInterval(() => {}, 1000)
