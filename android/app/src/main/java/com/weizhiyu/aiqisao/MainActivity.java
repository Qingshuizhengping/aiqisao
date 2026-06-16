package com.weizhiyu.aiqisao;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.content.Context;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final String REMOTE_URL = "https://web-production-b0601.up.railway.app/";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();
        if (webView != null) {
            WebSettings settings = webView.getSettings();

            // DOM Storage（对话历史）
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);

            // JavaScript
            settings.setJavaScriptEnabled(true);

            // 文件访问
            settings.setAllowFileAccess(true);
            settings.setAllowContentAccess(true);

            // 自适应缩放
            settings.setUseWideViewPort(true);
            settings.setLoadWithOverviewMode(true);

            // 混合内容
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

            // 缓存：有网时正常加载，离线时用缓存
            settings.setCacheMode(WebSettings.LOAD_DEFAULT);

            // 设置 WebViewClient 处理加载错误
            webView.setWebViewClient(new WebViewClient() {
                @Override
                public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                    // 加载本地离线页面
                    view.loadUrl("file:///android_asset/public/index.html");
                }

                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    // 让所有链接都在 WebView 内打开
                    return false;
                }
            });
        }
    }
}
