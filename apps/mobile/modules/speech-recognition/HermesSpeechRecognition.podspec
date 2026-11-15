required_assets = ['frameworks/SherpaOnnxC.xcframework/Info.plist',
                   'model/encoder.int8.onnx', 'model/decoder.onnx',
                   'model/joiner.int8.onnx', 'model/tokens.txt']
unless required_assets.all? { |path| File.file?(File.join(__dir__, 'vendor', path)) }
  raise 'Offline speech assets are missing. Run pnpm setup:speech, then run pod install again.'
end

Pod::Spec.new do |s|
  s.name           = 'HermesSpeechRecognition'
  s.version        = '1.0.0'
  s.summary        = 'On-device Chinese streaming speech recognition'
  s.description    = 'Offline Zipformer transcription with sherpa-onnx and microphone capture.'
  s.author         = 'Hermes Mobile'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'UIKit'
  s.vendored_frameworks = 'vendor/frameworks/SherpaOnnxC.xcframework'
  s.resource_bundles = { 'HermesSpeechModel' => ['vendor/model/*.onnx', 'vendor/model/tokens.txt', 'vendor/model/README.md', 'vendor/licenses/*'] }

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "ios/**/*.{h,m,mm,swift,hpp,cpp}"
end
