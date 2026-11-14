"""向 Hermes 移动端收件箱和 Bark 主动投递。"""


def register(ctx):
    from .adapter import register_platform
    from .bark import register_bark

    register_platform(ctx)
    register_bark(ctx)
