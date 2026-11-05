//go:build tools

package rhtunnel

// gomobile bind needs golang.org/x/mobile/bind in the module; this keeps it in go.mod. Never compiled.
import _ "golang.org/x/mobile/bind"
