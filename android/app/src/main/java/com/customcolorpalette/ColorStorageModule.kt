package com.customcolorpalette

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

class ColorStorageModule(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "ColorStorage"

    @ReactMethod
    fun writeFile(path: String, content: String, promise: Promise) {
        try {
            val file = File(path)
            file.parentFile?.mkdirs()
            file.writeText(content, Charsets.UTF_8)
            promise.resolve(true)
        } catch (t: Throwable) {
            promise.reject("EWRITE", t.message ?: "write failed", t)
        }
    }

    @ReactMethod
    fun readFile(path: String, promise: Promise) {
        try {
            val file = File(path)
            promise.resolve(if (file.exists()) file.readText(Charsets.UTF_8) else "")
        } catch (t: Throwable) {
            promise.reject("EREAD", t.message ?: "read failed", t)
        }
    }
}
