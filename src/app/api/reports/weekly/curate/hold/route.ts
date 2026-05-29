// Thin wrapper — defers to the shared /publish handler with action='hold'.
// We split the URL so the UI can use clean RESTful POST /hold semantics.
export { POST } from '../publish/route'
