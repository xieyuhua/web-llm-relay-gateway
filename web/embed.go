// Package web 将 test.html 等静态资源打包进二进制，避免依赖进程工作目录。
package web

import "embed"

// FS 包含本目录下的所有静态资源（*.html）。
//
//go:embed *.html
var FS embed.FS
