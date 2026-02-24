"""FastAPI application wiring for Lucida service endpoints."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from lucida.errors import LucidaError, as_api_error_payload
from lucida.models.api import (
    DatasetOpenRequest,
    DatasetOpenResponse,
    SessionCreateRequest,
    SessionCreateResponse,
    ViewCreateRequest,
    ViewCreateResponse,
    ViewGetResponse,
    ViewUpdateRequest,
    ViewUpdateResponse,
)
from lucida.models.render import RenderImageRequest, RenderImageResponse
from lucida.service.dataset_service import DatasetService


def create_app(dataset_service: DatasetService | None = None) -> FastAPI:
    """Create and configure a FastAPI app with error handling and routes.

    Parameters
    ----------
    dataset_service:
        Optional preconfigured :class:`DatasetService` instance for dependency injection.

    Returns
    -------
    FastAPI
        Configured application instance.
    """
    app = FastAPI(title="Lucida", version="0.1.0")
    service = dataset_service or DatasetService()

    @app.exception_handler(LucidaError)
    async def lucida_error_handler(_: object, error: LucidaError) -> JSONResponse:
        """Translate :class:`LucidaError` instances into JSON error responses.

        Parameters
        ----------
        _: object
            Unused request object.
        error:
            Structured exception raised by the service layer.
        """
        return JSONResponse(status_code=error.status_code, content=as_api_error_payload(error))

    @app.exception_handler(RequestValidationError)
    async def request_validation_error_handler(
        _: object, error: RequestValidationError
    ) -> JSONResponse:
        """Translate Pydantic validation failures into client-visible payloads.

        Parameters
        ----------
        _: object
            Unused request object.
        error:
            Validation exception details.
        """
        return JSONResponse(
            status_code=422,
            content={
                "code": "invalid_request",
                "message": "Request validation failed.",
                "details": {"errors": error.errors()},
            },
        )

    @app.post("/dataset/open", response_model=DatasetOpenResponse)
    async def dataset_open(request: DatasetOpenRequest) -> DatasetOpenResponse:
        """Open a dataset from request payload and return its summary.

        Parameters
        ----------
        request:
            Parsed request payload.
        """
        return service.open_dataset(
            uri=request.uri,
            dataset_id=request.dataset_id,
            session_id=request.session_id,
            include_full_raw_metadata=request.include_full_raw_metadata,
        )

    @app.post("/session/create", response_model=SessionCreateResponse)
    async def session_create(_: SessionCreateRequest) -> SessionCreateResponse:
        """Create and return a new session.

        Parameters
        ----------
        _:
            Unused request object.
        """
        return service.create_session()

    @app.post("/view/create", response_model=ViewCreateResponse)
    async def view_create(request: ViewCreateRequest) -> ViewCreateResponse:
        """Create a new view from dataset and rendering parameters.

        Parameters
        ----------
        request:
            Parsed view creation request.
        """
        return service.create_view(
            dataset_id=request.dataset_id,
            session_id=request.session_id,
            mode=request.mode,
            multiscale_name=request.multiscale_name,
            viewport=request.viewport,
            selectors=request.selectors,
            view_2d=request.view_2d,
        )

    @app.get("/view/{view_id}", response_model=ViewGetResponse)
    async def view_get(view_id: str, session_id: str | None = None) -> ViewGetResponse:
        """Read a view by identifier, optionally scoped to a session.

        Parameters
        ----------
        view_id:
            Requested view id.
        session_id:
            Optional session filter.
        """
        return service.get_view(view_id=view_id, session_id=session_id)

    @app.post("/view/update", response_model=ViewUpdateResponse)
    async def view_update(request: ViewUpdateRequest) -> ViewUpdateResponse:
        """Apply JSON patch operations to a view.

        Parameters
        ----------
        request:
            Parsed patch request.
        """
        return service.update_view(
            view_id=request.view_id,
            patch=request.patch,
            session_id=request.session_id,
        )

    @app.post("/render/image", response_model=RenderImageResponse)
    async def render_image(request: RenderImageRequest) -> RenderImageResponse:
        """Render a view into a PNG image payload.

        Parameters
        ----------
        request:
            Parsed render request.
        """
        return service.render_image(
            view_id=request.view_id,
            session_id=request.session_id,
            request_id=request.request_id,
            overrides_json_patch=request.overrides_json_patch,
            output=request.output,
        )

    return app


app = create_app()
