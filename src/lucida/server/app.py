from __future__ import annotations

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from lucida.errors import LucidaError, as_api_error_payload
from lucida.models.api import DatasetOpenRequest, DatasetOpenResponse
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
            include_full_raw_metadata=request.include_full_raw_metadata,
        )

    return app


app = create_app()
