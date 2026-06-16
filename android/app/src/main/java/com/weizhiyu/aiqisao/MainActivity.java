package com.weizhiyu.aiqisao;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 在 Bridge 初始化后配置 WebView
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            WebSettings settings = webView.getSettings();

            // 启用 DOM Storage（localStorage 用于对话历史）
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);

            // 启用 JavaScript
            settings.setJavaScriptEnabled(true);

            // 允许文件访问（本地 HTML 需要加载内联资源）
            settings.setAllowFileAccess(true);
            settings.setAllowContentAccess(true);

            // 支持自适应缩放
            settings.setUseWideViewPort(true);
            settings.setLoadWithOverviewMode(true);

            // 允许混合内容（HTTP/HTTPS 混合）
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

            // 缓存策略：优先使用缓存，离线时也能加载
            settings.setCacheMode(WebSettings.LOAD_DEFAULT);
            settings.setAppCacheEnabled(true);
        }
    }
}
