import UIKit
import Capacitor
import Photos
import PhotosUI

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

// MARK: - PhotoOriginal
//
// The page's <input type=file> path cannot work on iOS: the system picker hands
// back a JPEG that the OS transcoded on the way in, and every item this app
// rewrites (style plist, MakerNote, gain map, embedded thumbnail) is already
// gone by then. This plugin reads the *original* file bytes out of PhotoKit and
// writes the processed bytes back, never going through UIImage/CGImage — any
// re-encode would destroy exactly the same data.
//
// It lives here rather than in a file of its own because a new Swift file has
// to be registered in project.pbxproj to be compiled, and this file is already
// in the target.

@objc(PhotoOriginalPlugin)
public class PhotoOriginalPlugin: CAPPlugin, CAPBridgedPlugin, PHPickerViewControllerDelegate {
    public let identifier = "PhotoOriginalPlugin"
    public let jsName = "PhotoOriginal"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pick", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise)
    ]

    /// PHPickerViewController holds its delegate weakly and the page may await
    /// the call for a long time, so both have to be kept alive here.
    private var pendingPick: CAPPluginCall?
    private var picker: PHPickerViewController?

    private let workDirectory: URL = {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("PhotoOriginal", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }()

    // MARK: - pick

    @objc func pick(_ call: CAPPluginCall) {
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] status in
            DispatchQueue.main.async {
                guard let self = self else { return }

                // Limited access hides photos from PHAsset.fetchAssets, and the
                // picker can still hand back an assetIdentifier for one of them.
                // Failing here with a readable code is what lets the page point
                // at the setting instead of reporting "not a HEIC" further down.
                guard status == .authorized else {
                    call.reject("Full Photo Library access is required to read the original HEIC file.",
                                "need_full_access")
                    return
                }

                guard self.pendingPick == nil else {
                    call.reject("The photo picker is already open.", "picker_busy")
                    return
                }

                self.pendingPick = call
                let configuration = PHPickerConfiguration(photoLibrary: .shared())
                configuration.filter = .images
                configuration.selectionLimit = 0
                let picker = PHPickerViewController(configuration: configuration)
                picker.delegate = self
                self.picker = picker
                self.bridge?.viewController?.present(picker, animated: true)
            }
        }
    }

    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        self.picker = nil

        guard let call = pendingPick else { return }
        pendingPick = nil

        guard !results.isEmpty else {
            // Cancelling is not an error; the page just has nothing to do.
            call.resolve(["files": []])
            return
        }

        var assets: [PHAsset] = []
        for result in results {
            guard let identifier = result.assetIdentifier,
                  let asset = PHAsset.fetchAssets(withLocalIdentifiers: [identifier], options: nil).firstObject
            else { continue }
            assets.append(asset)
        }

        guard !assets.isEmpty else {
            call.reject("Could not read the selected photo from the Photo Library.", "asset_unavailable")
            return
        }

        let group = DispatchGroup()
        let lock = NSLock()
        var files: [[String: String]] = []
        var failure: Error?

        for asset in assets {
            // `.photo` is the original still image. `.fullSizePhoto` would be the
            // rendered version of an edited photo, and a Live Photo also carries a
            // `.pairedVideo`; neither is the file this app rewrites.
            guard let resource = PHAssetResource.assetResources(for: asset).first(where: { $0.type == .photo })
            else { continue }

            let filename = resource.originalFilename.replacingOccurrences(of: "/", with: "_")
            let destination = self.workDirectory.appendingPathComponent("\(UUID().uuidString)-\(filename)")

            let options = PHAssetResourceRequestOptions()
            // The original may live only in iCloud.
            options.isNetworkAccessAllowed = true

            group.enter()
            PHAssetResourceManager.default().writeData(for: resource, toFile: destination, options: options) { error in
                lock.lock()
                defer { lock.unlock() }
                if let error = error {
                    if failure == nil { failure = error }
                    group.leave()
                    return
                }
                if let webPath = self.bridge?.portablePath(fromLocalURL: destination)?.absoluteString {
                    files.append(["webPath": webPath, "name": resource.originalFilename])
                }
                group.leave()
            }
        }

        group.notify(queue: .main) {
            if files.isEmpty {
                if let failure = failure {
                    call.reject("Could not read the original photo: \(failure.localizedDescription)",
                                "read_failed")
                } else {
                    call.reject("The selection contained no readable original photo.", "no_original")
                }
                return
            }
            call.resolve(["files": files])
        }
    }

    // MARK: - save

    @objc func save(_ call: CAPPluginCall) {
        guard let encoded = call.getString("data"), let data = Data(base64Encoded: encoded) else {
            call.reject("Expected a base64 `data` payload.", "bad_data")
            return
        }
        let name = call.getString("name")

        PHPhotoLibrary.shared().performChanges({
            let request = PHAssetCreationRequest.forAsset()
            let options = PHAssetResourceCreationOptions()
            // Keeping the page's filename makes the saved copy recognisable in
            // Photos and preserves the fact that it is a HEIC.
            if let name = name { options.originalFilename = name }
            request.addResource(with: .photo, data: data, options: options)
        }, completionHandler: { success, error in
            DispatchQueue.main.async {
                if success {
                    call.resolve(["saved": true])
                } else {
                    let reason = error?.localizedDescription ?? "unknown error"
                    call.reject("Could not save to the Photo Library: \(reason)", "save_failed")
                }
            }
        })
    }
}

// MARK: - Bridge view controller
//
// Capacitor only exposes registerPluginInstance(_:) to a CAPBridgeViewController
// subclass, so the stock bridge that SceneDelegate and Main.storyboard build has
// to be replaced by this one for the plugin above to exist in the web view.

class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(PhotoOriginalPlugin())
    }
}
