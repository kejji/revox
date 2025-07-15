export default {
  Auth: {
    region: "eu-west-3",
    userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
    userPoolWebClientId: import.meta.env.VITE_COGNITO_APP_CLIENT_ID,
    authenticationFlowType: "USER_PASSWORD_AUTH"
  }
};
