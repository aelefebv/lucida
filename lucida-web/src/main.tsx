import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { WorkspaceRoot } from './WorkspaceRoot.tsx'
import { AuthGate } from './auth/AuthGate.tsx'
import { installTraceSeam, resolveGpuIdentity } from './trace/seam.ts'
import { traceRecorder } from './trace/recorder.ts'
import { installAppearance } from './theme/appearance.ts'
import { installDeploymentTheme } from './theme/deployment.ts'
import { isCaptureSurface } from './captureSurface.ts'

// The trace seam is public interface in every build (ADR 0051): a
// diagnostic that only exists in development cannot explain a field report.
installTraceSeam()
void resolveGpuIdentity().then(gpu => traceRecorder.setGpu(gpu))

// index.html already applied the stored appearance before first paint; this
// keeps it current as preferences and the OS setting change. The deployment's
// defaults go first, so the two agree from the start.
void installDeploymentTheme()
installAppearance()

// An unlinked review page for the primitives, kept out of the main bundle.
const UiGallery = lazy(() => import('./ui/gallery/UiGallery.tsx'))
// Loaded after first paint; toast() queues until it mounts.
const ToastRegion = lazy(() => import('./ui/Toast.tsx').then((m) => ({ default: m.ToastRegion })))
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
    {!isCaptureSurface() && (
      <Suspense fallback={null}>
        <ToastRegion />
      </Suspense>
    )}
  </StrictMode>,
)
