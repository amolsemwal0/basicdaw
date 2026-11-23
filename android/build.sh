#!/usr/bin/env bash
# Build the Android app on Linux.
#   android/build.sh            ->  android/dist/BasicDAW-<version>.apk        (signed release: install on phones)
#   android/build.sh --debug    ->  android/dist/BasicDAW-<version>-debug.apk  (WebView debugging on, for testing)
#   add --accept-android-licenses to accept the Android SDK licenses without the interactive prompt
# The first run downloads a JDK 21, the Android SDK (command-line tools, platform 35) and Gradle into
# android/.tools (about 1.5 GB), unless JAVA_HOME (17-24) / ANDROID_HOME already point at them.
# It also makes the app's signing key in android/signing/ - keep that folder: updates must be signed with it.
set -euo pipefail
cd "$(dirname "$0")"

JDK_URL=https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse
SDK_TOOLS_URL=https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip
SDK_PACKAGES=("platforms;android-35" "build-tools;35.0.0" "platform-tools")
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' ../pyproject.toml)

VARIANT=release ACCEPT=0
for arg in "$@"; do
  case $arg in
    --debug) VARIANT=debug ;;
    --accept-android-licenses) ACCEPT=1 ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done

TOOLS=$PWD/.tools
mkdir -p "$TOOLS"
fetch() { [[ -f "$2" ]] || { echo "downloading $(basename "$2")"; curl -fL --progress-bar -o "$2.part" "$1" && mv "$2.part" "$2"; }; }
java_major() { "$1/bin/java" -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1; }

# JDK: Gradle 8.14 runs on Java 17-24
if [[ -z "${JAVA_HOME:-}" ]] || (( $(java_major "$JAVA_HOME") < 17 || $(java_major "$JAVA_HOME") > 24 )); then
  if [[ ! -x "$TOOLS/jdk/bin/java" ]]; then
    fetch "$JDK_URL" "$TOOLS/jdk.tar.gz"
    mkdir -p "$TOOLS/jdk" && tar -xzf "$TOOLS/jdk.tar.gz" -C "$TOOLS/jdk" --strip-components=1
  fi
  export JAVA_HOME=$TOOLS/jdk
fi

# Android SDK
export ANDROID_HOME=${ANDROID_HOME:-$TOOLS/android-sdk}
SDKMANAGER=$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager
if [[ ! -x "$SDKMANAGER" ]]; then
  fetch "$SDK_TOOLS_URL" "$TOOLS/cmdline-tools.zip"
  rm -rf "$TOOLS/cmdline-tools-unpacked" && unzip -q "$TOOLS/cmdline-tools.zip" -d "$TOOLS/cmdline-tools-unpacked"
  mkdir -p "$ANDROID_HOME/cmdline-tools" && mv "$TOOLS/cmdline-tools-unpacked/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf "$TOOLS/cmdline-tools-unpacked"
fi
if [[ ! -d "$ANDROID_HOME/licenses" ]]; then
  if (( ACCEPT )); then
    yes | "$SDKMANAGER" --sdk_root="$ANDROID_HOME" --licenses >/dev/null
  else
    echo "The Android SDK needs its licenses accepted (read them and answer y):"
    "$SDKMANAGER" --sdk_root="$ANDROID_HOME" --licenses
  fi
fi
for pkg in "${SDK_PACKAGES[@]}"; do
  [[ -d "$ANDROID_HOME/${pkg//;//}" ]] || "$SDKMANAGER" --sdk_root="$ANDROID_HOME" --install "$pkg" >/dev/null
done

# Gradle: ./gradlew downloads the version pinned in gradle/wrapper/gradle-wrapper.properties (and checks its
# SHA-256) into GRADLE_USER_HOME. The wrapper is also how GitHub's CodeQL scan learns which Gradle to use.
export GRADLE_USER_HOME=$TOOLS/gradle-home

# Signing key for release builds (made once; back up android/signing/)
if [[ $VARIANT == release && ! -f signing/keystore.properties ]]; then
  mkdir -p signing
  pass=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')
  "$JAVA_HOME/bin/keytool" -genkeypair -keystore signing/basicdaw-release.jks -alias basicdaw -keyalg RSA -keysize 4096 \
    -validity 36500 -storepass "$pass" -keypass "$pass" -dname "CN=BasicDAW" >/dev/null 2>&1
  printf 'storeFile=basicdaw-release.jks\nstorePassword=%s\nkeyAlias=basicdaw\nkeyPassword=%s\n' "$pass" "$pass" >signing/keystore.properties
  chmod 600 signing/keystore.properties signing/basicdaw-release.jks
  echo "made the signing key in android/signing/ - back it up: app updates must be signed with it"
fi

# Chaquopy compiles the Python code with the same Python version as the app's (3.13) when it can find one.
args=()
if command -v uv >/dev/null 2>&1 && py=$(uv python find 3.13 2>/dev/null); then args+=("-PbuildPython=$py"); fi
echo "building the $VARIANT APK (Gradle)"
./gradlew --quiet "${args[@]}" "assemble${VARIANT^}"

mkdir -p dist
suffix=$([[ $VARIANT == debug ]] && echo "-debug" || true)
cp "app/build/outputs/apk/$VARIANT/app-$VARIANT.apk" "dist/BasicDAW-$VERSION$suffix.apk"
echo "APK: android/dist/BasicDAW-$VERSION$suffix.apk"
