/** Ignores SIGTERM (for the supervisor's kill timeout test). */
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
