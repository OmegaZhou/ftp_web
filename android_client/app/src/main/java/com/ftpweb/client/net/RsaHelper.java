package com.ftpweb.client.net;

import android.util.Base64;

import com.ftpweb.client.config.ServerConfig;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.spec.RSAPublicKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import javax.crypto.Cipher;

/**
 * RSA 公钥加密工具：
 * 1) GET {baseUrl}/ftp/api/pub_rsa 拉取公钥（PEM 或裸 DER Base64 均兼容）；
 * 2) 同时兼容 PKCS#1（BEGIN RSA PUBLIC KEY）与 X509/SPKI（BEGIN PUBLIC KEY）两种公钥格式：
 *    - PKCS#1 走手工 TLV 解析 SEQUENCE{INTEGER modulus, INTEGER exponent} → RSAPublicKeySpec；
 *    - X509 走 X509EncodedKeySpec；裸 DER 先试 X509，失败回退 PKCS#1。
 * 3) 公钥按 baseUrl 分服务器缓存（ConcurrentHashMap），换服务器自动重新拉取；
 * 4) 以 RSA/ECB/PKCS1Padding 加密，返回 Base64 密文。
 * baseUrl 从 ServerConfig 读取。
 */
public class RsaHelper {
    private static final Map<String, PublicKey> cache =
            new ConcurrentHashMap<String, PublicKey>();

    private RsaHelper() {
    }

    /**
     * 对明文加密，返回 Base64 密文（NO_WRAP，无换行）。
     */
    public static String encrypt(String plain) throws Exception {
        if (plain == null) {
            plain = "";
        }
        PublicKey pub = getPublicKey();
        Cipher cipher = Cipher.getInstance("RSA/ECB/PKCS1Padding");
        cipher.init(Cipher.ENCRYPT_MODE, pub);
        byte[] encrypted = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(encrypted, Base64.NO_WRAP);
    }

    private static PublicKey getPublicKey() throws Exception {
        String baseUrl = ServerConfig.getInstance().getBaseUrl();
        if (baseUrl == null || baseUrl.isEmpty()) {
            throw new Exception("服务器地址未配置");
        }
        PublicKey pub = cache.get(baseUrl);
        if (pub != null) {
            return pub;
        }
        String pem = fetchPublicKeyText(baseUrl);
        PublicKey built = buildPublicKey(pem);
        cache.put(baseUrl, built);
        return built;
    }

    private static String fetchPublicKeyText(String baseUrl) throws Exception {
        URL url = new URL(baseUrl + "/ftp/api/pub_rsa");
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(10000);
        try {
            conn.setRequestMethod("GET");
            int code = conn.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) {
                throw new Exception("获取公钥失败, HTTP " + code);
            }
            InputStream in = conn.getInputStream();
            try {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) != -1) {
                    bos.write(buf, 0, n);
                }
                return new String(bos.toByteArray(), StandardCharsets.UTF_8).trim();
            } finally {
                in.close();
            }
        } finally {
            conn.disconnect();
        }
    }

    /**
     * 将 PEM/裸 Base64 文本解码为 DER 字节。
     * 兼容 PKCS#1 与 X509 两种 PEM 头尾（无对应标记时为 no-op），并去掉全部空白。
     */
    private static byte[] decodePem(String pem) {
        if (pem == null) {
            return new byte[0];
        }
        String base64 = pem
                .replace("-----BEGIN RSA PUBLIC KEY-----", "")
                .replace("-----END RSA PUBLIC KEY-----", "")
                .replace("-----BEGIN PUBLIC KEY-----", "")
                .replace("-----END PUBLIC KEY-----", "")
                .replaceAll("\\s+", "");
        return Base64.decode(base64, Base64.DEFAULT);
    }

    /**
     * 构建 RSA 公钥，兼容三种输入：
     * - PKCS#1 PEM（BEGIN RSA PUBLIC KEY）：手工 TLV 解析 modulus/exponent；
     * - X509 PEM（BEGIN PUBLIC KEY）：X509EncodedKeySpec；
     * - 裸 DER Base64：先试 X509，失败回退 PKCS#1。
     */
    private static PublicKey buildPublicKey(String pem) throws Exception {
        if (pem == null || pem.trim().isEmpty()) {
            throw new Exception("公钥内容为空");
        }
        if (pem.contains("BEGIN RSA PUBLIC KEY")) {
            return parsePkcs1(decodePem(pem));
        }
        if (pem.contains("BEGIN PUBLIC KEY")) {
            return KeyFactory.getInstance("RSA")
                    .generatePublic(new X509EncodedKeySpec(decodePem(pem)));
        }
        // 裸 DER Base64：先试 X509，异常回退 PKCS#1
        byte[] der = decodePem(pem);
        try {
            return KeyFactory.getInstance("RSA")
                    .generatePublic(new X509EncodedKeySpec(der));
        } catch (Exception x509Err) {
            return parsePkcs1(der);
        }
    }

    /**
     * 手工解析 PKCS#1 公钥 DER：
     * SEQUENCE(0x30) { INTEGER(0x02) modulus, INTEGER(0x02) publicExponent }
     * 不依赖 bouncycastle，任何结构非法即抛异常（上层转为登录失败提示，不崩溃）。
     */
    private static PublicKey parsePkcs1(byte[] der) throws Exception {
        DerReader reader = new DerReader(der);
        if (reader.readTag() != 0x30) {
            throw new Exception("PKCS#1 结构非法: 顶层非 SEQUENCE");
        }
        int seqLen = reader.readLength();
        if (seqLen < 0 || seqLen > reader.remaining()) {
            throw new Exception("PKCS#1 SEQUENCE 长度越界");
        }
        int end = reader.pos + seqLen;

        if (reader.readTag() != 0x02) {
            throw new Exception("PKCS#1 结构非法: 首个元素非 INTEGER");
        }
        byte[] modulusBytes = reader.readValue(reader.readLength());

        if (reader.pos >= end || reader.readTag() != 0x02) {
            throw new Exception("PKCS#1 结构非法: 缺少 publicExponent INTEGER");
        }
        byte[] exponentBytes = reader.readValue(reader.readLength());

        BigInteger modulus = new BigInteger(1, modulusBytes);
        BigInteger exponent = new BigInteger(1, exponentBytes);
        RSAPublicKeySpec spec = new RSAPublicKeySpec(modulus, exponent);
        return KeyFactory.getInstance("RSA").generatePublic(spec);
    }

    /**
     * 简易 DER TLV 读取器：读 tag/长度/值，全程越界防护。
     * 长度编码支持短格式（首字节 &lt;0x80 单字节）与长格式（首字节 0x80|n 后跟 n 字节）。
     */
    private static class DerReader {
        private final byte[] data;
        private int pos;

        DerReader(byte[] data) {
            this.data = data;
            this.pos = 0;
        }

        int readTag() throws Exception {
            if (pos >= data.length) {
                throw new Exception("DER 数据不足: 读取 tag 越界");
            }
            int tag = data[pos++] & 0xFF;
            if (tag == 0) {
                throw new Exception("DER tag 非法: 0x00");
            }
            return tag;
        }

        int readLength() throws Exception {
            if (pos >= data.length) {
                throw new Exception("DER 数据不足: 读取长度越界");
            }
            int first = data[pos++] & 0xFF;
            if (first < 0x80) {
                return first;
            }
            int count = first & 0x7F;
            if (count == 0 || count > 4) {
                throw new Exception("DER 长度编码非法");
            }
            if (pos + count > data.length) {
                throw new Exception("DER 数据不足: 长度字节越界");
            }
            int len = 0;
            for (int i = 0; i < count; i++) {
                len = (len << 8) | (data[pos++] & 0xFF);
            }
            return len;
        }

        byte[] readValue(int len) throws Exception {
            if (len < 0 || pos + len > data.length) {
                throw new Exception("DER 数据不足: 读取值越界");
            }
            byte[] val = new byte[len];
            System.arraycopy(data, pos, val, 0, len);
            pos += len;
            return val;
        }

        int remaining() {
            return data.length - pos;
        }
    }
}
