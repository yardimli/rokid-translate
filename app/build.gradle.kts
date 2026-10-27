import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
val bootstrap = Properties().apply {
    val file = rootProject.file("bootstrap.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
fun quoted(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "") + "\""
android {
    namespace = "computer.playground.rokidtest"
    compileSdk = 35
    defaultConfig {
        applicationId = "computer.playground.rokidtest"
        minSdk = 31
        targetSdk = 35
        versionCode = 9
        versionName = "0.2.6"
        buildConfigField("String", "SERVER_URL", quoted(bootstrap.getProperty("serverUrl", "https://translate.playground.computer")))
        buildConfigField("String", "DEVICE_TOKEN", quoted(bootstrap.getProperty("deviceToken", "")))
    }
    buildFeatures { buildConfig = true }
    signingConfigs {
        getByName("debug") {
            val localKey = rootProject.file("debug.keystore")
            if (localKey.exists()) storeFile = localKey
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
