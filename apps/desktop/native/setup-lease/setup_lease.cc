#include <node_api.h>
#ifdef _WIN32
#include <windows.h>
#include <bcrypt.h>
#include <algorithm>
#include <cstdint>
#include <cwctype>
#include <string>
#include <vector>

struct Lease {
  HANDLE file = INVALID_HANDLE_VALUE;
  std::vector<HANDLE> directories;
  bool closed = false;
  ~Lease() { Close(); }
  void Close() {
    if (closed) return;
    closed = true;
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    for (auto it = directories.rbegin(); it != directories.rend(); ++it) CloseHandle(*it);
  }
};

// Build-stamp admission checks this marker in the pinned PE before packaging.
static const char kProtocol[] = "youtab.setup-lease/napi-v1";

static napi_value Fail(napi_env env, const char* code) {
  napi_throw_error(env, code, code);
  return nullptr;
}

static bool String(napi_env env, napi_value value, std::wstring& out) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || length > 32760) return false;
  std::vector<char16_t> chars(length + 1);
  if (napi_get_value_string_utf16(env, value, chars.data(), chars.size(), &length) != napi_ok) return false;
  out.assign(reinterpret_cast<const wchar_t*>(chars.data()), length);
  return out.find(L'\0') == std::wstring::npos;
}

static bool SafePath(const std::wstring& path) {
  if (path.size() < 4 || !iswalpha(path[0]) || path[1] != L':' || path[2] != L'\\') return false;
  if (path.find(L'/') != std::wstring::npos || path.find(L':', 2) != std::wstring::npos) return false;
  size_t offset = 3;
  while (offset < path.size()) {
    size_t end = path.find(L'\\', offset);
    if (end == std::wstring::npos) end = path.size();
    const auto part = path.substr(offset, end - offset);
    if (part.empty() || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ') return false;
    offset = end + 1;
  }
  return true;
}

static bool NoReparse(HANDLE handle, bool directory) {
  FILE_ATTRIBUTE_TAG_INFO tag{};
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag)) ||
      !GetFileInformationByHandle(handle, &info)) return false;
  if (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) return false;
  return directory ? (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0
                   : (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 && info.nNumberOfLinks == 1;
}

static bool HashFile(HANDLE file, const std::wstring& wanted, uint64_t expectedSize) {
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file, &size) || size.QuadPart < 0 || static_cast<uint64_t>(size.QuadPart) != expectedSize) return false;
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  std::vector<UCHAR> object;
  DWORD objectLength = 0, returned = 0;
  bool ok = false;
  do {
    if (!BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0))) break;
    if (!BCRYPT_SUCCESS(BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objectLength), sizeof(objectLength), &returned, 0))) break;
    object.resize(objectLength);
    if (!BCRYPT_SUCCESS(BCryptCreateHash(algorithm, &hash, object.data(), objectLength, nullptr, 0, 0))) break;
    std::vector<UCHAR> block(64 * 1024);
    uint64_t total = 0;
    for (;;) {
      DWORD count = 0;
      if (!ReadFile(file, block.data(), static_cast<DWORD>(block.size()), &count, nullptr)) break;
      if (!count) {
        UCHAR digest[32]{};
        if (total != expectedSize || !BCRYPT_SUCCESS(BCryptFinishHash(hash, digest, sizeof(digest), 0))) break;
        static const wchar_t hex[] = L"0123456789abcdef";
        std::wstring actual;
        for (UCHAR byte : digest) { actual.push_back(hex[byte >> 4]); actual.push_back(hex[byte & 15]); }
        LARGE_INTEGER after{};
        ok = actual == wanted && GetFileSizeEx(file, &after) && static_cast<uint64_t>(after.QuadPart) == expectedSize;
        break;
      }
      total += count;
      if (total > expectedSize || !BCRYPT_SUCCESS(BCryptHashData(hash, block.data(), count, 0))) break;
    }
  } while (false);
  if (hash) BCryptDestroyHash(hash);
  if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
  return ok;
}

static void Finalize(napi_env, void* data, void*) { delete static_cast<Lease*>(data); }

static napi_value Acquire(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 3) return Fail(env, "SETUP_LEASE_INPUT");
  std::wstring path, sha;
  int64_t size = 0;
  if (!String(env, args[0], path) || !SafePath(path) || !String(env, args[1], sha) || sha.size() != 64 ||
      !std::all_of(sha.begin(), sha.end(), [](wchar_t ch) { return (ch >= L'0' && ch <= L'9') || (ch >= L'a' && ch <= L'f'); }) ||
      napi_get_value_int64(env, args[2], &size) != napi_ok || size < 64 || size > 128LL * 1024 * 1024) return Fail(env, "SETUP_LEASE_INPUT");
  auto* lease = new Lease();
  std::wstring current = path.substr(0, 3);
  size_t offset = 3;
  while (true) {
    const size_t end = path.find(L'\\', offset);
    if (end == std::wstring::npos) break;
    current += path.substr(offset, end - offset);
    HANDLE dir = CreateFileW(current.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (dir == INVALID_HANDLE_VALUE || !NoReparse(dir, true)) {
      if (dir != INVALID_HANDLE_VALUE) CloseHandle(dir);
      delete lease;
      return Fail(env, "SETUP_LEASE_NAMESPACE");
    }
    lease->directories.push_back(dir);
    current += L'\\';
    offset = end + 1;
  }
  lease->file = CreateFileW(path.c_str(), GENERIC_READ | FILE_EXECUTE, FILE_SHARE_READ,
    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (lease->file == INVALID_HANDLE_VALUE || !NoReparse(lease->file, false) ||
      !HashFile(lease->file, sha, static_cast<uint64_t>(size))) {
    delete lease;
    return Fail(env, "SETUP_LEASE_IDENTITY");
  }
  napi_value result;
  if (napi_create_external(env, lease, Finalize, nullptr, &result) != napi_ok) {
    delete lease;
    return Fail(env, "SETUP_LEASE_UNAVAILABLE");
  }
  return result;
}

static napi_value Release(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  if (napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr) != napi_ok || argc != 1) return Fail(env, "SETUP_LEASE_INPUT");
  void* data = nullptr;
  if (napi_get_value_external(env, arg, &data) != napi_ok || !data) return Fail(env, "SETUP_LEASE_INPUT");
  static_cast<Lease*>(data)->Close();
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value Protocol(napi_env env, napi_callback_info) {
  napi_value result;
  napi_create_string_utf8(env, kProtocol, NAPI_AUTO_LENGTH, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
    {"acquire", nullptr, Acquire, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"release", nullptr, Release, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"protocol", nullptr, Protocol, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, 3, descriptors);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
#endif
