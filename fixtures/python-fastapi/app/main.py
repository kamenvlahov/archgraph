from fastapi import FastAPI

from app.orders.router import router as orders_router


def create_app() -> FastAPI:
    app = FastAPI(title="Orders")
    app.include_router(orders_router)
    return app


app = create_app()
