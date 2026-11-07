from fastapi import FastAPI

from app.orders.router import router as orders_router


def create_app() -> FastAPI:
    app = FastAPI(title="Orders")
    app.include_router(orders_router)
    return app


def warm_up() -> None:
    # Импорт вътре във функцията важи само в нея.
    from app.orders.dependencies import get_repository

    get_repository().find(0)


app = create_app()
