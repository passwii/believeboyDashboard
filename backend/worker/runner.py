from redis import Redis
from rq import Connection, Worker

from app.core.config import get_settings


def main() -> None:
    settings = get_settings()
    redis = Redis.from_url(settings.redis_url)
    with Connection(redis):
        worker = Worker(['default'])
        worker.work(with_scheduler=False)


if __name__ == '__main__':
    main()
