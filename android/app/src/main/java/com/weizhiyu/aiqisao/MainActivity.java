package com.weizhiyu.aiqisao;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {

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

            webView.setWebViewClient(new BridgeWebViewClient(getBridge()) {
                @Override
                public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                    super.onReceivedError(view, request, error);
                    if (request.isForMainFrame()
                            && "https".equals(request.getUrl().getScheme())
                            && "8.134.141.217".equals(request.getUrl().getHost())) {
                        view.loadUrl("file:///android_asset/public/index.html");
                    }
                }
            });
        }
    }
}
