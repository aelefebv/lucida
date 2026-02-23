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
from lucida.service.dataset_service import DatasetService


def create_app(dataset_service: DatasetService | None = None) -> FastAPI:
    app = FastAPI(title="Lucida", version="0.1.0")
    service = dataset_service or DatasetService()

    @app.exception_handler(LucidaError)
    async def lucida_error_handler(_: object, error: LucidaError) -> JSONResponse:
        return JSONResponse(status_code=error.status_code, content=as_api_error_payload(error))

    @app.exception_handler(RequestValidationError)
    async def request_validation_error_handler(
        _: object, error: RequestValidationError
    ) -> JSONResponse:
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
        return service.open_dataset(
            uri=request.uri,
            dataset_id=request.dataset_id,
            session_id=request.session_id,
            include_full_raw_metadata=request.include_full_raw_metadata,
        )

    @app.post("/session/create", response_model=SessionCreateResponse)
    async def session_create(_: SessionCreateRequest) -> SessionCreateResponse:
        return service.create_session()

    @app.post("/view/create", response_model=ViewCreateResponse)
    async def view_create(request: ViewCreateRequest) -> ViewCreateResponse:
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
        return service.get_view(view_id=view_id, session_id=session_id)

    @app.post("/view/update", response_model=ViewUpdateResponse)
    async def view_update(request: ViewUpdateRequest) -> ViewUpdateResponse:
        return service.update_view(
            view_id=request.view_id,
            patch=request.patch,
            session_id=request.session_id,
        )

    return app


app = create_app()
