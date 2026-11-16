"""向 Hermes 移动端会话、收件箱和 Bark 主动投递。"""


def register(ctx):
    from .adapter import register_platform
    from .bark import register_bark
    from .profile import register_profile_tools
    from .steering import register_steering_events

    register_platform(ctx)
    register_bark(ctx)
    register_profile_tools(ctx)
    register_steering_events(ctx)
