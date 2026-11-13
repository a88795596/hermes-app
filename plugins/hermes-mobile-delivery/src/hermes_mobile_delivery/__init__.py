"""Active delivery to the Hermes Mobile Inbox."""


def register(ctx):
    from .adapter import register_platform

    register_platform(ctx)
