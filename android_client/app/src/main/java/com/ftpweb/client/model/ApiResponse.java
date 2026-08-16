package com.ftpweb.client.model;

/**
 * 与后端 createRes(message, result) 对应：
 * <pre>{@code
 * { "message": "success" | "Error" | "Need login" | "Login failed, remain N times",
 *   "result":  JSONObject | JSONArray | 纯字符串 | null }
 * }</pre>
 */
public class ApiResponse {
    /** "success" / "Error" / "Need login" / "Login failed, remain N times" 等 */
    public String message;
    /** 原始 JSON 字符串（JSONObject / JSONArray / 纯字符串 / null） */
    public String result;

    public ApiResponse() {
    }

    public ApiResponse(String message, String result) {
        this.message = message;
        this.result = result;
    }
}
