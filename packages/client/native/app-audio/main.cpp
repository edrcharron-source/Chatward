// Chatward app audio: plays back the sound of ONE app, for sharing a single window with its sound.
//
// Usage: chatward-app-audio.exe <window handle> <Chatward's process id>
//
// Finds the app that owns the window and records only that app's sound (and the processes it started) with the
// Windows "process loopback" capture (Windows 10 build 20348 / Windows 11 and later). Nothing else on the PC is
// recorded, so the voice chat and other apps stay out of the share. The sound is written to standard output as raw
// 48 kHz stereo 16-bit PCM. It stops when Chatward closes the pipe, kills it, or exits.
//
// Exit codes: 0 stopped, 1 bad arguments, 2 no such window, 3 the window is Chatward's own,
//             4 this Windows can't record one app (or recording failed to start), 5 recording failed while running.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <cstdlib>
#include <cwchar>

#if __has_include(<audioclientactivationparams.h>)
#include <audioclientactivationparams.h>
#else
// Older SDK headers (MinGW) lack these; the values are from the Windows SDK.
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
typedef enum { AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1 } AUDIOCLIENT_ACTIVATION_TYPE;
typedef enum { PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1 } PROCESS_LOOPBACK_MODE;
typedef struct { DWORD TargetProcessId; PROCESS_LOOPBACK_MODE ProcessLoopbackMode; } AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;
typedef struct {
  AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
  union { AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams; };
} AUDIOCLIENT_ACTIVATION_PARAMS;
#endif

static const IID kIID_IAudioClient = {0x1CB9AD4C, 0xDBFA, 0x4c32, {0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2}};
static const IID kIID_IAudioCaptureClient = {0xC8ADBD64, 0xE71E, 0x48a0, {0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17}};
static const IID kIID_IAgileObject = {0x94ea2b94, 0xe9cc, 0x49e0, {0xc0, 0xff, 0xee, 0x64, 0xca, 0x8f, 0x5b, 0x90}};
static const IID kIID_IActivateAudioInterfaceCompletionHandler = {0x41D949AB, 0x9862, 0x444A, {0x80, 0xF6, 0xC2, 0x61, 0x33, 0x4D, 0xA5, 0xEB}};

// Called by Windows when the recorder is ready. It must be "agile" (callable from any thread), hence IAgileObject.
class Activated final : public IActivateAudioInterfaceCompletionHandler {
 public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT result = E_FAIL;
  IAudioClient* client = nullptr;

  STDMETHODIMP QueryInterface(REFIID riid, void** out) override {
    if (riid == IID_IUnknown || riid == kIID_IActivateAudioInterfaceCompletionHandler || riid == kIID_IAgileObject) {
      *out = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  // Lives for the whole program, so reference counting is not needed.
  STDMETHODIMP_(ULONG) AddRef() override { return 2; }
  STDMETHODIMP_(ULONG) Release() override { return 1; }

  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT activated = E_FAIL;
    IUnknown* unknown = nullptr;
    result = op->GetActivateResult(&activated, &unknown);
    if (SUCCEEDED(result)) result = activated;
    if (SUCCEEDED(result) && unknown) result = unknown->QueryInterface(kIID_IAudioClient, reinterpret_cast<void**>(&client));
    if (unknown) unknown->Release();
    SetEvent(done);
    return S_OK;
  }
};

static bool writeAll(HANDLE out, const void* data, DWORD size) {
  const BYTE* p = static_cast<const BYTE*>(data);
  while (size > 0) {
    DWORD written = 0;
    if (!WriteFile(out, p, size, &written, nullptr) || written == 0) return false;
    p += written;
    size -= written;
  }
  return true;
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 3) return 1;
  const HWND window = reinterpret_cast<HWND>(static_cast<INT_PTR>(_wcstoui64(argv[1], nullptr, 10)));
  const DWORD chatwardPid = static_cast<DWORD>(wcstoul(argv[2], nullptr, 10));
  if (!window || !chatwardPid) return 1;

  DWORD pid = 0;
  if (!IsWindow(window) || !GetWindowThreadProcessId(window, &pid) || !pid) return 2;
  // Recording Chatward itself would send the voice chat back into the call.
  if (pid == chatwardPid || pid == GetCurrentProcessId()) return 3;

  // Stop when Chatward goes away, even if it never closes the pipe.
  HANDLE chatward = OpenProcess(SYNCHRONIZE, FALSE, chatwardPid);
  if (!chatward) return 1;

  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 4;

  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT activation = {};
  activation.vt = VT_BLOB;
  activation.blob.cbSize = sizeof(params);
  activation.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  static Activated handler;
  IActivateAudioInterfaceAsyncOperation* op = nullptr;
  if (FAILED(ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, kIID_IAudioClient, &activation, &handler, &op))) return 4;
  if (WaitForSingleObject(handler.done, 5000) != WAIT_OBJECT_0 || FAILED(handler.result) || !handler.client) return 4;
  IAudioClient* client = handler.client;

  // A process loopback recorder can't report its own format, so ask for one; Windows converts to it.
  WAVEFORMATEX format = {};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = 2;
  format.nSamplesPerSec = 48000;
  format.wBitsPerSample = 16;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  const DWORD flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
  if (FAILED(client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 200000 /* 20 ms */, 0, &format, nullptr))) return 4;

  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  IAudioCaptureClient* capture = nullptr;
  if (!ready || FAILED(client->SetEventHandle(ready)) ||
      FAILED(client->GetService(kIID_IAudioCaptureClient, reinterpret_cast<void**>(&capture))) || FAILED(client->Start()))
    return 4;

  const HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  static BYTE silence[48000 * 4];  // one second of silence, for packets Windows marks as silent
  for (;;) {
    if (WaitForSingleObject(chatward, 0) == WAIT_OBJECT_0) return 0;
    WaitForSingleObject(ready, 200);
    UINT32 waiting = 0;
    while (SUCCEEDED(capture->GetNextPacketSize(&waiting)) && waiting > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD bufferFlags = 0;
      if (FAILED(capture->GetBuffer(&data, &frames, &bufferFlags, nullptr, nullptr))) return 5;
      const DWORD bytes = frames * format.nBlockAlign;
      const bool silent = (bufferFlags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
      const bool ok = bytes <= sizeof(silence) && writeAll(out, silent ? silence : data, bytes);
      capture->ReleaseBuffer(frames);
      if (!ok) return 0;  // Chatward closed the pipe: the share ended.
    }
  }
}
