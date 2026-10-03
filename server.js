// Play a build: /play/<id>/ serves the unzipped export. By default builds run sandboxed (opaque origin, no access to
// this site's storage). Set BUILD_SANDBOX=0 for threaded Godot builds that need cross-origin isolation (trusted use only).
app.get('/play/:id', (req, res, next) => {
  // Avoid a redirect loop: only redirect bare /play/<id> URLs to the canonical trailing-slash form.
  if (req.originalUrl === '/play/' + req.params.id) return res.redirect(302, '/play/' + req.params.id + '/');
  next();
});
app.get('/play/:id/*', async (req, res) => {
