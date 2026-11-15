import ExpoModulesCore

public class HermesSpeechRecognitionModule: Module {
  private let runtime = SpeechRecognitionRuntime()

  public func definition() -> ModuleDefinition {
    Name("HermesSpeechRecognition")
    Events("result", "status", "error")

    Function("isAvailable") { true }

    AsyncFunction("start") { (id: String, promise: Promise) in
      self.runtime.start(id: id, event: { [weak self] name, body in
        self?.sendEvent(name, body)
      }) { result in
        switch result {
        case .success: promise.resolve()
        case .failure(let error): promise.reject(error)
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("stop") { (id: String, promise: Promise) in
      self.runtime.stop(id: id) { result in
        switch result {
        case .success(let text): promise.resolve(text)
        case .failure(let error): promise.reject(error)
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("cancel") { (id: String) in
      self.runtime.cancel(id: id)
    }.runOnQueue(.main)

    OnDestroy { [runtime] in
      DispatchQueue.main.async { runtime.destroy() }
    }
  }
}
