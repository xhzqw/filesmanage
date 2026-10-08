package application

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Minimal HS256 JWT for the document editor contract. The editor secret never
// leaves the server; tokens carry only claims the editor needs.

var errJWT = errors.New("invalid token")

func signJWT(secret string, claims map[string]any, ttl time.Duration) (string, error) {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload := map[string]any{}
	for k, v := range claims {
		payload[k] = v
	}
	now := time.Now()
	payload["iat"] = now.Unix()
	payload["exp"] = now.Add(ttl).Unix()
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	signing := header + "." + base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signing))
	return signing + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func verifyJWT(secret, token string) (map[string]any, error) {
	return verifyJWTWith(secret, token, true)
}

// verifyJWTWith checks the signature and, when requireExp is set, rejects
// tokens without a live exp claim. Callback tokens minted by the document
// server may omit exp, so that path relaxes the check while keeping the
// signature mandatory.
func verifyJWTWith(secret, token string, requireExp bool) (map[string]any, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errJWT
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(parts[2])) {
		return nil, errJWT
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, errJWT
	}
	var claims map[string]any
	if err = json.Unmarshal(body, &claims); err != nil {
		return nil, errJWT
	}
	if requireExp {
		exp, ok := claims["exp"].(float64)
		if !ok {
			return nil, errJWT
		}
		if time.Now().Unix() > int64(exp) {
			return nil, errJWT
		}
	} else if exp, ok := claims["exp"].(float64); ok && time.Now().Unix() > int64(exp) {
		return nil, errJWT
	}
	return claims, nil
}
