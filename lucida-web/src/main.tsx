import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { WorkspaceRoot } from './WorkspaceRoot.tsx'
import { AuthGate } from './auth/AuthGate.tsx'
import { installTraceSeam, resolveGpuIdentity } from './trace/seam.ts'
import { traceRecorder } from './trace/recorder.ts'
import { installAppearance } from './theme/appearance.ts'
import { ToastRegion } from './ui/Toast.tsx'
import { isCaptureSurface } from './captureSurface.ts'

// The trace seam is public interface in every build (ADR 0051): a
// diagnostic that only exists in development cannot explain a field report.
installTraceSeam()
void resolveGpuIdentity().then(gpu => traceRecorder.setGpu(gpu))

// index.html already applied the stored appearance before first paint; this
// keeps it current as preferences and the OS setting change.
installAppearance()

// An unlinked review page for the primitives, kept out of the main bundle.
const UiGallery = lazy(() => import('./ui/gallery/UiGallery.tsx'))
const isGallery = /^\/ui-gallery\/?$/.test(window.location.pathname)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isGallery ? (
      <Suspense fallback={null}>
        <UiGallery />
      </Suspense>
    ) : (
      <AuthGate>
        <WorkspaceRoot />
      </AuthGate>
    )}
    {!isCaptureSurface() && <ToastRegion />}
  </StrictMode>,
)
