"""向 Hermes 移动端收件箱主动投递。"""


def register(ctx):
    from .adapter import register_platform

    register_platform(ctx)
