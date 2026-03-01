import time


def main() -> None:
    print('Worker runner is disabled in no-Redis mode. Jobs run in-process from API.')
    while True:
        time.sleep(3600)


if __name__ == '__main__':
    main()
