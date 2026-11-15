#!/bin/sh
set -eu
module_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
xcrun swiftc -typecheck -target arm64-apple-ios16.4 \
  -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" \
  -F "$module_dir/vendor/frameworks/SherpaOnnxC.xcframework/ios-arm64" \
  "$module_dir/ios/StreamingRecognizer.swift" "$module_dir/ios/SpeechRecognitionRuntime.swift"
xcrun swiftc -frontend -parse "$module_dir/ios/HermesSpeechRecognitionModule.swift"
printf '%s\n' 'Speech runtime iOS SDK typecheck and module parse passed'

# Pass the model release's test_wavs/0.wav to additionally run real inference on a booted simulator.
if [ "$#" -gt 0 ]; then
  test_dir=$(mktemp -d)
  trap 'rm -rf "$test_dir"' EXIT
  framework_dir="$module_dir/vendor/frameworks/SherpaOnnxC.xcframework/ios-arm64_x86_64-simulator"
  xcrun swiftc -target "$(uname -m)-apple-ios16.4-simulator" \
    -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
    -F "$framework_dir" -framework SherpaOnnxC \
    -Xlinker -rpath -Xlinker "$framework_dir" \
    "$module_dir/ios/StreamingRecognizer.swift" "$module_dir/tests/recognizer-check.swift" \
    -o "$test_dir/recognizer-check"
  xcrun simctl spawn "${SPEECH_SIMULATOR_ID:-booted}" "$test_dir/recognizer-check" "$module_dir/vendor/model" "$1"
fi
