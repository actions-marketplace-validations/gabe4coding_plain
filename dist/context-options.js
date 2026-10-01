export function browserContextOptions(spec, _opts) {
    const options = {};
    if (spec.auth)
        options.httpCredentials = { username: spec.auth.user, password: spec.auth.pass };
    if (spec.geolocation) {
        options.geolocation = { latitude: spec.geolocation.lat, longitude: spec.geolocation.lon };
        options.permissions = ['geolocation'];
    }
    return options;
}
