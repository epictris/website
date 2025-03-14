package env

import (
	"os"
)

func getEnvWithDefault(key string, defaultValue string) string {
	value, exists := os.LookupEnv(key)
	if !exists {
		return defaultValue
	}
	return value
}

var DATA_DIR = getEnvWithDefault("DATA_DIR", "/data")
var DEPLOY_ENV = getEnvWithDefault("DEPLOY_ENV", "tris.sh")
