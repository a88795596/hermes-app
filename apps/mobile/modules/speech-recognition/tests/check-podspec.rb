require 'cocoapods'

root = Pathname.new(File.expand_path('..', __dir__))
spec = Pod::Specification.from_file(root + 'HermesSpeechRecognition.podspec')
files = Pod::Sandbox::FileAccessor.new(root, spec.consumer(:ios))
frameworks = files.vendored_frameworks.map { |path| path.basename.to_s }
abort 'CocoaPods did not collect SherpaOnnxC.xcframework' unless frameworks == ['SherpaOnnxC.xcframework']

resources = files.resource_bundles.fetch('HermesSpeechModel')
models = %w[encoder.int8.onnx decoder.onnx joiner.int8.onnx tokens.txt]
missing = models - resources.map { |path| path.basename.to_s }
abort "CocoaPods did not collect model resources: #{missing.join(', ')}" unless missing.empty?
abort 'CocoaPods collected no native implementation' unless files.source_files.length == 3
puts "CocoaPods collected #{frameworks.first}, #{files.source_files.length} Swift files, and #{resources.sum(&:size)} bytes of model resources"
