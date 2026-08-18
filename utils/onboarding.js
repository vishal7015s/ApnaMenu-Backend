/** Customer profile setup is done when name is saved (GPS lives in app store). */
function hasCompletedCustomerProfile(user) {
  return !!(user?.name && String(user.name).trim());
}

/**
 * Where to send the user after OTP — DB-driven (survives app clear data).
 * @returns {'complete' | 'role_selection' | 'customer_profile' | 'kitchen_registration'}
 */
function resolveOnboardingStep(user, kitchenId) {
  if (user?.role === 'kitchen') {
    return kitchenId ? 'complete' : 'kitchen_registration';
  }

  if (hasCompletedCustomerProfile(user)) {
    return 'complete';
  }

  if (!user?.signupIntent) {
    return 'role_selection';
  }

  if (user.signupIntent === 'kitchen') {
    return 'kitchen_registration';
  }

  return 'customer_profile';
}

module.exports = {
  hasCompletedCustomerProfile,
  resolveOnboardingStep,
};
